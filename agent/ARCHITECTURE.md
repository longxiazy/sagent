# agent/ 架构说明

本文件描述 `agent/` 整体：五个子系统如何分工、一次 run 从 HTTP 请求到 SSE 回传的完整链路、以及在哪里扩展。

- `agent/core/` 的**模块级**详述（每个文件的职责、导出、调用方）见 [core/ARCHITECTURE.md](core/ARCHITECTURE.md)，本文不重复。
- 仓库级架构（客户端、路由、持久化）见根目录 [ARCHITECTURE.md](../ARCHITECTURE.md) 与 [CLAUDE.md](../CLAUDE.md)。

## 一句话概括

`core/runtime.ts` 提供一个**不认识任何具体工具**的步骤循环；`desktop/agent.ts` 是唯一的装配根，把 planner（决策）、policy（审批）、tools（执行）注入这个循环，拼成可运行的 Agent。`worker/` 决定这一切跑在主进程还是隔离子进程里。

## 分层总览

```text
┌──────────────────────────────────────────────────────────────────────┐
│  入口层（在 agent/ 之外，但决定它如何被调用）                        │
│  server.ts · routes/agent-run-*.ts · helpers/run-agent.ts            │
├──────────────────────────────────────────────────────────────────────┤
│  worker/（可选的进程隔离层，默认开启）                               │
│  runner.ts（主进程侧桥接）· agent-worker.ts（子进程入口）            │
├──────────────────────────────────────────────────────────────────────┤
│  desktop/（装配根：把下面三层拼成一个可运行的 Agent）                │
│  agent.ts — 注入 initialize/observe/decide/authorize/execute         │
│  planner/ — 模型路由 + race / vote / progressive 调度                │
│  observer.ts · browser-session-manager.ts                            │
├──────────────────────────────────────────────────────────────────────┤
│  core/（运行时内核 — 模块级详述见 core/ARCHITECTURE.md）             │
│  runtime.ts（步骤循环）· router.ts（动作分发）                       │
│  planner / prompts / schemas / providers / 各类 store                │
│  契约层：contracts.ts · action-types.ts · config-schema.ts           │
├──────────────────────────────────────────────────────────────────────┤
│  policy/（副作用闸门：执行前的最后一道关）                           │
│  classify.ts（动作风险分类）· approvals.ts（授权器）                 │
├──────────────────────────────────────────────────────────────────────┤
│  tools/（具体能力实现，彼此独立）                                    │
│  browser · chrome · fs · terminal · search · vision · mcp · macos    │
└──────────────────────────────────────────────────────────────────────┘
```

关键点：**上面四层都不 import `tools/`**，只有 `desktop/agent.ts` 认识具体工具。core 与 tools 之间没有直接依赖（两处例外见 core 文档）。

## 装配：desktop/agent.ts 注入了什么

`createDesktopAgentRunner()` 返回 `runDesktopAgent`，后者调用 `runAgentRuntime()` 并注入下列实现（[desktop/agent.ts:283-351](desktop/agent.ts:283)）：

| 注入参数 | 由谁提供 | 说明 |
|---|---|---|
| `initialize` | agent.ts 就地构造 | 产出贯穿整个循环的可变 state（runId/model/projectRoot/dataDir/browserSession…） |
| `observe` | `observer.ts` | 包在浏览器串行队列里，避免读到页面切换的中间态 |
| `decide` | `planner/index.ts` 的 `createDesktopPlanner()` | 模型路由 + 三种调度策略 |
| `authorize` | `policy/approvals.ts` 的 `createAgentAuthorizer()` | 分类 → 需要时阻塞等审批 |
| `execute` | `core/router.ts` 的 `createActionRouter()` | 按 `action.tool` 分发到 tools |
| `cleanup` | `browser-session-manager.ts` | 普通会话复位复用，隐私会话关闭并删临时 profile |
| `shouldObserve` | agent.ts 就地判断 | `fs`/`terminal` 执行后跳过观测（结果已进 history） |
| `saveSessionSnapshot` | `core/checkpoint.ts` 或 worker 桥接 | 有持久化队列时入队，保证写入次序 |

router 注册了 8 个 handler：`core` / `browser` / `fs` / `search` / `vision` / `chrome` / `mcp` / `terminal`，`defaultTool: 'core'`（[desktop/agent.ts:131-235](desktop/agent.ts:131)）。**没有 `macos`** —— 见下文。

运行参数每次 run 都从 `configStore` 重读（[desktop/agent.ts:118-128](desktop/agent.ts:118)），所以前台改完设置无需重启；工厂入参里的 `maxSteps`/`modelTimeoutMs` 等目前不参与兜底。

## 一次 run 的端到端时序

```text
POST /api/agent
  │
  ├─ routes/agent-run-start.ts
  │    resolveRunPathsForExecution  → 定位 projectRoot / dataDir（无项目回退 projects/default）
  │    resolveCheckpointSeed        → fromCheckpoint 转成起始 step/history
  │    agentRunStore.tryCreateRun   → 全局单运行锁，已有活动 run 则 409
  │    sessionStore.recordRunStart  → 落 user 消息 + pending 占位
  │    transitionRun('running')
  │    loadMemoryForPrompt          → agent-memory.json 注入 systemPrompt
  │
  ├─ routes/agent-run-execution.ts → 调用 runDesktopAgent
  │
  ├─【沙箱模式】worker/runner.ts spawn 子进程
  │    父 → 子: {type:'start'|'cancel'|'rollback'|'approval_response'}
  │    子 → 父: {type:'event'|'approval_request'|'session_checkpoint_snapshot'
  │              |'result'|'error'}
  │    stdout 专供 JSON 行协议，stderr 走诊断日志
  │    子进程重新 init：configStore / llmLogger / createClients / WebView 数据目录
  │
  └─ core/runtime.ts 步骤循环（每步）
       observe   → desktop/observer.ts（macOS helper + 内置浏览器，并行）
       decide    → planner：路由重排 → race/vote/progressive → 单个 AgentDecision
                   ↳ core/prompts 构造提示 → provider 调模型 → core/schemas 归一化
       authorize → policy/classify 分级
                   safe    → 直接放行
                   blocked → 拒绝，不执行
                   confirm → approval-store 创建阻塞 Promise，
                             run 转 waiting_approval，等路由层 resolve
       execute   → router 按 tool 分发 → tools/*/execute.ts
       快照      → checkpoint.saveHealthySnapshot（隐私 run 跳过）
       每步的 observe/action/result 都作为 SSE 事件流回前端
  │
  └─ 收尾：result-quality 评估 → recordRunTerminal → persistAgentRunMemory
           → cleanupAgentRun（flush 持久化、清快照、关 Chrome MCP、closeRun）
```

审批之所以要跨 HTTP 请求协调，是因为 Agent 循环阻塞在 `approval-store` 的 Promise 上，而解除它的 `POST /api/agent/approvals` 是另一个请求。

## 子系统详述

### desktop/ — 装配与调度

- **agent.ts** — 唯一装配根（上一节）。同时处理两处工具模型的四级解析：`http_fetch` 结果的 distill 提炼、`image_analyze` 的 vision 模型。
- **planner/index.ts** — `createDesktopPlanner()`：先经 `core/model-routing` 重排候选（仅在 `autoModelRouting` 开启时生效），再按策略调度。
  - **单模型**不走任何策略分支，直连 `single-model-path.ts`：命中 429 就地指数退避重试（多模型下不重试，直接换模型）；超时则拉黑并抛出。
  - **race**（UI「竞速」，默认）— 按 `batchSize` 分批、批间隔 `staggerDelaySec` 错峰启动，首个有效结果胜出并 abort 其余。整批全失败时跳过延迟直接续批（仅 race 有此规则）。
  - **vote**（UI「汇总」）— 同时启动全部活动模型并等齐，由 `core/multi-model.ts` 聚合多数派。例外：任一模型返回 `finish` 立即短路。
  - **progressive** — 先只跑主模型，超时未返回或提前失败才唤醒其余加入竞速。**未接入 UI**，但 `strategy` 字段不做白名单校验，API 直调可用。
- **planner/model-pool.ts** — 两种不可用状态语义不同：**黑名单**（超时，本次 run 内不恢复）vs **冷却**（429，到期自动恢复）。全部不可用时只重置黑名单——冷却硬闯只会再撞一次限流。
- **observer.ts** — 把 macOS 桌面观测与内置浏览器观测**并行**采集后合并成统一 observation；未启用/未建会话时返回空占位，保证 planner 总收到稳定结构。
- **browser-session-manager.ts** — 内置浏览器会话按 `headless + privateMode` 匹配复用，全部操作走一条串行队列；WebView 失效时重建一次，再失败则本 run 熔断。

### policy/ — 副作用闸门

`classifyAgentAction()` 返回三档 `level`（[policy/classify.ts:48](policy/classify.ts:48)）：

| level | 含义 | 覆盖动作 |
|---|---|---|
| `safe` | 直接执行 | 全部 browser 动作、`web_search`、`image_analyze`、fs 只读四件（`list_dir`/`get_file_info`/`read_file`/`search_files`）、白名单内的 `run_safe`、`chrome_list_tools`、`SAFE_CHROME_TOOLS` 内的 `chrome_call_tool`、`mcp_list_*`、`notify_user`、`finish` |
| `confirm` | 阻塞等用户审批 | `write_file`、`run_confirmed`/`run_review`、白名单外的 Chrome 工具、`mcp_call_tool`、`ask_user` |
| `blocked` | 拒绝执行 | 命中危险命令正则（`rm`/`sudo`/`dd`/管道到 shell/重定向到系统路径/进程替换）、以及**未被上述规则匹配的一切动作**（默认拒绝） |

两个值得注意的设计：

- `run_safe` 若不在白名单内但也不危险，会被**就地改写**成 `run_confirmed` 走审批（[classify.ts:131](policy/classify.ts:131)），而不是报错让模型多跑一轮。
- `SAFE_CHROME_TOOLS` 放行了 `click`/`fill`/`type_text` 等浏览器内交互（无持久副作用），但**不放** `evaluate_script`（任意 JS）和 `upload_file`。

`createAgentAuthorizer()` 是 `authorize` 的注入实现：`safe` 直接返回 approved；`blocked` 发 `approval_result` 事件并返回 rejected；`confirm` 向 approval-store 申请阻塞 Promise、把 run 切到 `waiting_approval`、等 resolve 后再切回 `running`。

### tools/ — 能力实现

每个子目录导出一个 `execute*Action()` 入口，由 router 调用。

| 子目录 | 入口 | 关键约束 |
|---|---|---|
| **browser** | `executeBrowserAction` | **只读**：`navigate`/`wait`/`scroll`/`get_page_content`/`http_fetch`。`click`/`type` 保留识别但**明确拒绝**并引导去 Chrome MCP（[browser/execute.ts:279-293](tools/browser/execute.ts:279)）——保留是为兼容旧 trace/checkpoint。检测到反爬拦截时也会提示改用 Chrome MCP。 |
| **chrome** | `executeChromeAction` | 经 SSE 桥接真实 Chrome 的 DevTools MCP（默认 `127.0.0.1:3099/sse`）。所有交互式网页操作（登录、上传、点击）走这里。 |
| **fs** | `executeFsAction` | 双重沙箱：词法校验 + `realpath` 后再校验，防软链逃逸；敏感路径黑名单；`@uploads/` 前缀映射到 `dataDir/uploads` 独立根。 |
| **terminal** | `executeTerminalAction` | `run_safe` 走**无 shell** 的单进程执行，命令行分词与参数都要过 `safe-policy.ts` 校验；审批后的 `run_confirmed` 才进 zsh。 |
| **search** | `executeSearchAction` | DuckDuckGo HTML 抓取，只读，带请求超时。 |
| **vision** | `executeVisionAction` | 图片 10MB 上限（data URL 分支单独校验，防构造超大 data URL 绕过）；模型两步解析，兜底模型不保证多模态，不支持时由实际调用报错暴露。 |
| **mcp** | `executeGenericMcpAction` | 通用 MCP server 的发现与调用，连接参数读自 `configStore` 的 `mcpServers`。 |
| **macos** | `observeMacOSDesktop` | **不在 action 链路上**——`action-types.ts` 无 macos 映射，router 未注册该 key，`AgentTool` 联合里也没有。唯一调用方是 `desktop/observer.ts`，纯观测用。优先走原生 helper，失败回退 AppleScript。 |

### worker/ — 进程隔离

默认开启（`execution.sandboxedWorkers` 未设或 `true`）。两个开关语义不同：

- **`sandboxedWorkers`** — 决定是否 spawn 子进程。config-only，改后**必须重启**后端（runner 类型在 `server.ts:110` 启动时固定）。
- **`workerSandbox`** — 决定子进程是否再套一层 macOS `sandbox-exec -f sandbox.sb`，用 `HOME`/`PROJECT_DIR`/`MEMORY_DIR` 三个参数限定可写范围。接受 `AGENT_WORKER_SANDBOX` 环境变量覆盖。

**runner.ts（主进程侧）**持有全部权威状态：run 状态机、审批、SSE 投递、checkpoint 落盘。子进程只是执行器。

**agent-worker.ts（子进程）**必须重新初始化一整套全局，因为它是独立进程：`configStore.init` / `initLlmLogger` / `createClients` / `initWebViewDataStore`。它把 stdout 让给 JSON 行协议，`console.log`/`console.debug` 全部重定向到 stderr。

取消是三级升级：先发协议 `cancel`，超时 SIGTERM，再超时 SIGKILL。子进程异常退出而未回 `result` 时，父进程带上 stderr 尾部拒绝该 run。

## 依赖方向

```text
server.ts / routes ──→ worker/runner ──→（子进程）agent-worker ──┐
server.ts / routes ────────────────────────────────────────────┴─→ desktop/agent
desktop/agent ──→ core/runtime · core/router（两者是兄弟，runtime 不 import router）
desktop/agent ──→ policy/approvals ──→ policy/classify ──→ tools/terminal/safe-policy
desktop/agent ──→ tools/*（唯一认识具体工具的地方）
desktop/planner ──→ core/model-routing · core/multi-model · providers
desktop/observer ──→ tools/browser/observe · tools/macos/observe
core/* ──→ core/contracts（仅类型）
```

规则：**tools 之间互不依赖**；除 `desktop/agent.ts` 外没有模块同时认识多个工具；单一配置状态边界在 `core/config-store`。

## 扩展点

- **新工具** — 五处都要改，缺一不可：
  1. `core/action-types.ts` 加 type → tool 映射
  2. `core/contracts.ts` 加 `AgentAction` 分支（`AgentTool` 由它推导）
  3. `core/tool-definitions.ts` 加 schema（模型才看得见）
  4. `core/schemas.ts` 加归一化函数并在 `normalizeDesktopAgentDecision` 里接上
  5. `policy/classify.ts` 加分类——**漏了这步动作会落到默认 `blocked`**
  6. `desktop/agent.ts` 的 `createActionRouter` 注册 handler
- **新模型策略** — `desktop/planner/strategies/` 加文件，在 `planner/index.ts` 分派。
- **新供应商** — 见 [core/ARCHITECTURE.md](core/ARCHITECTURE.md#扩展点)。
- **纯观测能力**（不需要模型主动调用）— 参考 `tools/macos/`：只接 `desktop/observer.ts`，不进 action 映射表。
