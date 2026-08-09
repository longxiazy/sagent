# agent/core 架构说明

本文件描述 `agent/core/` 下的全部模块：职责、依赖与数据流。`agent/` 整体分工与一次 run 的端到端链路见 [agent/ARCHITECTURE.md](../ARCHITECTURE.md)；仓库级架构见根目录 [ARCHITECTURE.md](../../ARCHITECTURE.md) 与 [CLAUDE.md](../../CLAUDE.md)。

`agent/core/` 是 Agent 运行时的心脏：步骤循环与动作分发（runtime/router）**只依赖注入进来的函数**（initialize/observe/decide/authorize/execute/cleanup），不认识任何具体工具实现；同时这里提供全部共享的状态仓库、配置边界与纯函数工具。

两处例外要知道：`prompts.ts` 与 `tool-definitions.ts` 会探测 Chrome/通用 MCP 的可用性（import `agent/tools/*/client.ts`）来决定注入哪些工具 schema；`ai-client.ts` 直接持有 OpenAI/Gemini 两个 SDK 客户端。

## 分层总览

```text
┌────────────────────────────────────────────────────────────────┐
│  契约层（纯类型，无逻辑）                                      │
│  contracts.ts · action-types.ts · config-schema.ts             │
├────────────────────────────────────────────────────────────────┤
│  配置层（单例状态）                                            │
│  config-store.ts                                               │
├────────────────────────────────────────────────────────────────┤
│  执行中枢                                                      │
│  runtime.ts（步骤循环）· router.ts（动作分发）                 │
├────────────────────────────────────────────────────────────────┤
│  决策层（模型调用 + 提示词）                                   │
│  planner.ts · openai-compatible-request.ts                     │
│  nvidia-response-parsers.ts · prompts.ts · tool-definitions.ts │
│  model-routing.ts · multi-model.ts · context-estimate.ts       │
│  tool-model-resolver.ts · summarizer.ts                        │
├────────────────────────────────────────────────────────────────┤
│  存储层（跨请求状态与落盘）                                    │
│  approval-store.ts · session-store.ts · project-store.ts       │
│  memory.ts · checkpoint.ts                                     │
├────────────────────────────────────────────────────────────────┤
│  基础设施（无状态纯函数为主）                                  │
│  abort.ts · utils.ts · result-extraction.ts                    │
│  result-quality.ts · trace-replay.ts · llm-logger.ts           │
│  ai-client.ts · schemas.ts                                     │
├────────────────────────────────────────────────────────────────┤
│  供应商目录（下节详述）                                        │
│  providers/（registry + gemini + openai-compat）               │
└────────────────────────────────────────────────────────────────┘
```

## 分层详述

### 1. 契约层（纯类型）

- **contracts.ts** — 全仓库共享的核心类型：`AgentAction`（各工具动作的判别联合）、`AgentEvent`（SSE 事件）、`AgentStep`、`RunStatus` 状态机（`RUN_STATUS_TRANSITIONS`）、`RunRecord`、`RuntimeStepContext`/`RuntimeDecisionContext`/`AgentExecutionContext`、`ApprovalStore`/`AgentRunStore` 接口。外部模型/SDK 的未知数据必须在 adapter/schema 边界被校验，进入 runtime 后只使用这里的归一化类型。
- **action-types.ts** — Action type → tool 的静态映射表（`ACTION_TYPE_TO_TOOL`）与 `inferTool()`。模型返回缺 tool 字段的动作时用它补全。
- **config-schema.ts** — 全部 Agent 运行时字段的类型、默认值、范围、分组与四档预设（fast/economy/deep/besteffort），以及档位识别/校验纯函数。

### 2. 配置层

- **config-store.ts** — 唯一有状态的配置边界。`configStore` 单例：启动 `init()` 读 `data/config.json`（含 legacy 迁移），运行时 `get()` 同步热读取（无需重启生效）；`update()/applyProfile()/reset()/updateExecution()/updateMcpServer()/updateTools()` 校验+原子落盘。解析顺序：`schema 默认 < config.json < 每次 run 的覆盖`。

### 3. 执行中枢

- **runtime.ts** — 步骤循环 `runAgentRuntime()`：`observe → decide → authorize → execute → 快照/继续`。防循环（回声 finish、重复动作、重复识图）、回滚（`pendingRollback` → 加载 `loadLatestHealthySnapshot`）、步数用尽后的 `finalOnly` 总结、质量评估附注。全部过程由调用方注入函数驱动。
- **router.ts** — `createActionRouter()`：把归一化的 action 按 `tool` 字段分发到对应 handler，缺失时抛错。由 `desktop/agent.ts` 装配后作为 `execute` 注入 runtime，两者之间没有直接 import。

### 4. 决策层（提示词 → 模型 → 归一化）

- **prompts.ts** — 提示词构造中枢：按任务/历史关键词推断能力并选择工具（`selectGeminiToolNames`），构造 NVIDIA 与 Gemini 两套消息（全量/compact/finalOnly/原生 tool-call 四变式），内置规则与防原地踏步提示（最近 URL/搜索提示）。会 import `agent/tools/*/client.ts` 探测 Chrome/MCP 可用性。
- **tool-definitions.ts** — 全部工具的 schema 定义（含示例与规则说明），运行时按 Chrome/MCP 可用性动态注入（同样探测 `agent/tools/`），`toolToGeminiTool`/`toolToOpenAiTool` 转两种供应商格式。
- **planner.ts** — NVIDIA 线路的决策层：`createJsonPlanner()` 构造请求 → `nvidia-response-parsers` 解析 → `schemas.ts` 归一化；上下文不足时自动降 `max_tokens`/切 compact/回退 JSON-in-prompt。
- **openai-compatible-request.ts** — OpenAI 兼容请求构造与回退：`chat_template_kwargs`（deepseek 思考）、system role 不受支持时的两步降级重试。
- **nvidia-response-parsers.ts** — 模型响应解析工厂：按模型 ID 选择策略链（tool_calls/`[TOOL_CALL]` 块/XML/JSON/纯文本兜底）。
- **model-routing.ts** — 按任务难度启发式重排候选模型顺序（只排序不增删）。
- **multi-model.ts** — vote 策略的结果聚合（按 action 键取多数派 + consensus 字段）。
- **context-estimate.ts** — token/上下文占用估算：窗口推断、payload 递归估算、prompt 预览、风险档（≥80% danger）。
- **summarizer.ts** — provider `summarize()` 的封装（框式日志 + 异常重抛）。**当前无调用方**，记忆压缩路径尚未接入。
- **tool-model-resolver.ts** — vision/distill 等子任务的模型四级解析：项目覆盖 → 全局配置 → 环境变量 → 主模型兜底。

### 5. 存储层

- **approval-store.ts** — 跨 HTTP 请求的审批协调：`request()` 创建阻塞 Promise，路由层 `resolve()` 解除，`rejectAll()` 清理；带 run 匹配校验。
- **project-store.ts** — 一等项目概念：注册/激活/解析项目数据目录；`resolveRunPaths()` 处理无项目回退到 `projects/default` 全局桶。
- **session-store.ts** — 聊天会话与 run 摘要落盘：按 scope（全局/项目）独立队列，trace 恢复、upsert/删除/”拉黑“防复活，隐私模式只读。
- **memory.ts** — 跨会话记忆：`agent-memory.json` 读写、注入 prompt、从 run 结果提炼知识。
- **checkpoint.ts** — Session 级健康快照（`session-checkpoints/`）：写快照、读取最新待回滚快照、保留数裁剪与清理。

### 6. 基础设施

- **abort.ts** — 取消/超时合并工具：`createAbortScope()` 把多信号+deadline+timeout 合并，`throwIfAborted()` 做检查点。
- **utils.ts** — 共享纯函数：安全序列化、文本清洗、显示宽度对齐。
- **result-extraction.ts** — 长工具结果压缩：按句子信息密度选句 + 多来源并行压缩。
- **result-quality.ts** — 运行质量评估（由 `runtime.ts` 在收尾处调用）：官方来源缺失 → `done_unverified`，浏览意图无有效观测/失败步 → `done_degraded`。
- **trace-replay.ts** — trace 事件重建 `ReplayRun`（与 runtime 组装 history 口径一致），仅供离线评测（`scripts/trace-eval*.ts`）与测试使用，不在运行时链路上。
- **llm-logger.ts** — LLM 请求/响应按模型×日期写 JSONL（惰性批量 + flush），隐私 run 不落盘。
- **ai-client.ts** — SDK 客户端构造（OpenAI/NVIDIA + Gemini），模型噪声过滤与供应商名推导。

### 7. providers/（目录，简述）

- **registry.ts** — 供应商注册表与模型元信息解析。
- **openai-compat.ts / gemini.ts** — 两家供应商的 `agentPlan/chat/compact/confidentCompletion/summarize` 接口适配，内部复用 `planner.ts`、`prompts.ts`、`ai-client.ts` 的共享模块。

## 依赖方向

```text
desktop/agent ──→ runtime / router（两者是兄弟模块，runtime 不 import router）
providers ──→ planner ──→ nvidia-response-parsers / openai-compatible-request
providers ──→ prompts ──→ tool-definitions / action-types / result-extraction / config-store
runtime ──→ checkpoint / result-quality / result-extraction / config-store
session-store ──→ project-store / helpers/trace-store / helpers/persistence-queue
config-store ──→ config-schema
所有存储 ──→ contracts.ts（仅类型）
```

`trace-replay.ts` 不在运行时链路上：只有 `scripts/trace-eval*.ts` 与测试引用它。

规则：**下层不反向依赖上层**；纯函数层（utils/abort/result-*）不持有状态；单一状态边界在 `config-store`。

## 扩展点

- 新供应商：`providers/` 新增并按 registry 要求注册；展示名由 `ai-client.deriveProviderName` 从 baseURL 域名推导。
- 新工具：`agent/core/action-types.ts` 加映射 → `contracts.ts` 加 `AgentTool`/`AgentAction` → `tool-definitions.ts` 加 schema → `schemas.ts` 加归一化 → `agent/policy/classify.ts` 加审批分类。
- 新配置字段：`config-schema.ts` 声明（类型/默认/范围），消费者通过 `configStore.get()` 读取。
- 新存储：参考 `approval-store`/`session-store` 的单例工厂 + 串行队列模式。
