<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>本地多模型 AI 聊天与桌面 Agent 工作台。</p>
</div>

> sagent 以 macOS 桌面自动化为核心。Web UI 和 API 可以用 Docker 打包运行，但完整 Agent 能力依赖 macOS、Bun 1.3+ `Bun.WebView` 和本机系统权限。
>
> 英文版：[README.md](README.md)
>
> 环境变量和运行时配置：[CONFIGURATION.md](CONFIGURATION.md)
>
> 系统架构：[ARCHITECTURE.md](ARCHITECTURE.md)

## 项目简介

sagent 把 React Web UI、Bun/Express 后端和可调用工具的 Agent runtime 组合在一起。它可以接入多个模型供应商，执行桌面自动化，读写文件，运行终端命令，查看浏览器页面，调用 MCP 工具，并在不同会话之间保留项目记忆。

它更像一个本地 AI 工作台：选择项目目录，输入任务，审批敏感操作，然后在界面里实时查看每一步执行过程和最终结果。

## 核心特性

- 多模型聊天和 Agent 模式，支持竞速、投票汇总和渐进式竞速策略。
- macOS 桌面观察、截图、浏览器自动化，以及可选的 Chrome DevTools MCP 集成。
- 文件、终端、搜索、视觉、MCP、浏览器等工具统一接入 Agent runtime。
- 短生命周期 Agent Worker 可在设置中开关，macOS Sandbox 也可独立配置。
- 项目级记忆、trace、上传文件和会话回滚快照。
- 局域网内手机、平板、电脑都能实时查看 Agent 进度。
- 内置 smoke 测试和 trace 文件，方便功能开发后回归验证。

## 运行要求

- macOS，用于完整桌面 Agent 能力。
- Bun 1.3+。
- Node.js 和 npm，用于安装依赖、构建前端。
- 至少配置一个模型供应商 API Key，见 [CONFIGURATION.md](CONFIGURATION.md)。
- 推荐使用 Chromium 内核浏览器，以获得带「允许 / 拒绝」按钮的桌面通知。

## 快速开始

```bash
git clone https://github.com/longxiazy/sagent
cd sagent
cp .env.example .env
npm install
cd client && npm install && cd ..
npm run dev
```

如果还没填 API Key，请先编辑 `.env`。开发服务启动后打开 http://localhost:5173。

`npm run dev` 会启动 UI/API 开发服务。默认情况下，每次 Agent 任务都在短生命周期 Worker 中执行；在 macOS 上，开启 Worker Sandbox 后还会应用 `sandbox.sb`。这两个开关位于“设置 → Agent → 高级”，保存后需重启后端才生效。

启动后可在设置页选择 Agent Profile、调整基础/高级运行参数，并管理 Chrome 或通用 MCP 连接。这些值保存在本地 `data/config.json`，密钥仍保留在 `.env`。

## Docker 运行

Docker 会构建前端，并用一个 Bun 进程提供 UI/API 服务。它适合分发 server/UI 包；依赖桌面、系统 WebView 或宿主浏览器控制的 Agent 能力，仍建议在 macOS 上原生运行。

```bash
cp .env.example .env
docker compose up --build
```

打开 http://localhost:5173。

手动构建和运行：

```bash
docker build -t sagent:local .
docker run --env-file .env -p 5173:5173 -v "$(pwd)/data-docker:/app/data" sagent:local
```

## Agent 安全机制

Agent 等待审批时，sagent 会显示页面内审批面板，并发送浏览器桌面通知。Chromium 内核浏览器支持通知里的「允许 / 拒绝」按钮；Safari 和 Firefox 仍会弹出通知，点击后回到 sagent 页面处理审批。

删除文件、安装依赖、执行终端命令等危险操作都需要显式确认。在 macOS 上启用 Worker Sandbox 时，沙盒权限边界由 [sandbox.sb](sandbox.sb) 控制。

## 多设备查看

开发服务默认只监听 `127.0.0.1`。需要在局域网访问时，先在 `.env` 设置至少 16 位的 `SAGENT_API_TOKEN`，再显式暴露 Vite：

```bash
openssl rand -hex 24
# 把输出填入 .env 的 SAGENT_API_TOKEN=
VITE_HOST=0.0.0.0 npm run sandbox
```

局域网设备随后可打开 `http://<Mac-IP>:5173`，首次受保护请求会要求输入 Token。独立部署前端时，还需通过 `SAGENT_CORS_ORIGINS` 配置精确来源。

- Agent 运行中，其他设备展示执行流程，并在完成后收到最终结果。
- 普通聊天历史由后端保存在配置的数据目录中，认证后的设备可以读取；隐私模式会话不会持久化。
- 同一时间只能运行一个 Agent，新的任务请求会收到 409。
- 配置 Token 后，API、OpenAI 兼容 `/v1` 和截图接口都需要认证；后端监听非 loopback 地址时，没有合规 Token 将拒绝启动。

## 核心工作流

### 多模型 Agent

Agent 模式下，每一步都可以调用多个模型。竞速模式采用第一个有效结果并取消其余请求；投票模式会等待所有活动模型并聚合成功决策；渐进式模式先运行主模型，主模型过慢或失败时再让其余模型加入竞速。前端支持选择模型、调整优先级、切换策略。

### 会话回滚

普通 Agent 每完成一步，都会在本次运行的数据目录下 `session-checkpoints/` 写入一份健康快照，可将运行中的任务手动回滚到较早的步骤。取消任务会清理这些快照；隐私模式不创建快照，因此该模式下不支持回滚。后端重启后不再恢复中断的运行。

### 跨会话记忆

sagent 会在配置的数据目录下保存项目经验，包括近期任务摘要、压缩后的历史上下文和项目知识。侧边栏记忆面板可以查看、手动压缩或清空这些状态。

### 浏览器与 MCP 集成

内置 Browser 仅用于只读信息浏览和正文提取；点击、输入、登录、提交、上传、下载等网页交互统一由 Chrome DevTools MCP 负责。输入框工具栏中的“隐私模式”会让本次任务使用一次性 Browser profile，并在任务正常收尾时删除 Cookie 和 LocalStorage；同时跳过聊天会话、应用/运行日志、LLM 日志、trace、会话快照、Worker 日志和 sagent 自己管理的截图持久化。该隔离不覆盖外部 Chrome MCP：隐私模式既不会隔离它的浏览器 profile，也不会清除它的现有会话。Chrome MCP 会增加 `chrome_list_tools` 和 `chrome_call_tool`。包括 `codex mcp-server` 在内的通用 MCP server 会通过 `mcp_list_servers`、`mcp_list_tools` 和 `mcp_call_tool` 接入。所有集成都是可选能力，配置方式见 [CONFIGURATION.md](CONFIGURATION.md)。

### OpenTelemetry 追踪

每次 Agent 运行都会被记录成一棵 OpenTelemetry span 树：一个聊天会话是一条 trace，会话里的每次运行是一个根 span，每一步展开成 `observe`、每个参与决策的模型各一个 `chat`、以及 `execute_tool`。属性遵循 GenAI 语义约定，因此这些数据可直接被标准工具消费——Jaeger、Zipkin、Grafana Tempo 或各类托管服务都可以。

Trace 以 JSONL 形式写在各项目的 `traces/` 目录下，并携带 W3C 合规的追踪 ID。先看有哪些可导出，再转换：

```bash
npm run trace:otlp -- --list
```

```bash
npm run trace:otlp -- <runId> --pretty
```

产物默认写入 `data/otlp-exports/`。`--all` 转换全部已录制运行，`--project <id>` 指定项目 scope——注意位置参数是 **run id**，项目要走 `--project`。

默认情况下 span 只带结构化元数据——工具名、状态、token 数、时长——因为 GenAI 约定把提示词和模型输出视为敏感内容，要求默认不采集、由用户主动开启。加 `--content` 可一并导出任务正文、模型理由、工具入参和结果：

```bash
npm run trace:otlp -- <runId> --content --max-content 2000
```

默认不采集并不丢数据：完整内容始终留在 trace JSONL 里，需要时按需重新生成。凭据在写 trace 时已脱敏，但任务正文和页面内容不会——推送到共享后端前请先确认。

想看瀑布图，启动任意兼容 OTLP 的接收端并推送过去即可。Jaeger 最快：

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

```bash
npm run trace:otlp -- --all --endpoint http://localhost:4318/v1/traces
```

然后打开 `http://localhost:16686` 搜索 `sagent` 服务。隐私模式的运行不落 trace，因此也没有可导出的内容。

## 常用命令

```bash
npm run dev          # 启动 API server 和 Vite client；运行器模式由设置/配置决定
npm run prod         # 启动 API server（存在 client/dist 时同时提供前端）
npm run build        # 后端类型检查 + 前端构建
npm run lint         # 运行 ESLint
npm test             # 运行 Vitest 测试
npm run smoke        # 对运行中的服务执行 Agent 冒烟场景
npm run trace:otlp   # 把录制的 trace 转成 OpenTelemetry OTLP/JSON
npm run stop         # 停止前后端进程
npm run chrome:mcp   # 启动 Chrome DevTools MCP SSE bridge
```

运行 smoke 测试时，先启动 sagent，再在另一个终端执行 `npm run smoke`。报告会写入 `data/smoke-reports/`，失败用例会打印对应的 `data/projects/default/traces/` 文件路径。

## 目录结构

```text
agent/      Agent runtime、供应商、工具、策略、worker
routes/     Express API 路由
helpers/    后端共享 helper 和 store
client/     React/Vite 前端
scripts/    冒烟测试、停止脚本、Chrome MCP bridge
test/       Vitest 和集成测试
```

后端、Agent、worker、配置和持久化流程见 [ARCHITECTURE.md](ARCHITECTURE.md)，React 前端细节见 [client/ARCHITECTURE.md](client/ARCHITECTURE.md)。
