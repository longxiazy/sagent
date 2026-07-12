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

sagent 把 React Web UI、Bun/Express 后端和可调用工具的 Agent runtime 组合在一起。它可以接入多个模型供应商，执行桌面自动化，读写文件，运行终端命令，查看浏览器页面，调用 JetBrains IDE MCP 工具，并在不同会话之间保留项目记忆。

它更像一个本地 AI 工作台：选择项目目录，输入任务，审批敏感操作，然后在界面里实时查看每一步执行过程和最终结果。

## 核心特性

- 多模型聊天和 Agent 模式，支持竞速与汇总策略。
- macOS 桌面控制、截图、浏览器自动化，以及可选的 Chrome DevTools MCP 集成。
- 文件、终端、搜索、视觉、IDE MCP、浏览器等工具统一接入 Agent runtime。
- 使用 `npm run sandbox` 时，每次 Agent 任务都会进入短生命周期沙盒 worker。
- 项目级记忆、trace、上传文件、checkpoint 和中断恢复。
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
npm run sandbox
```

如果还没填 API Key，请先编辑 `.env`。开发服务启动后打开 http://localhost:5173。

`npm run sandbox` 会正常启动 UI/API server，并让每次 Agent 任务在 macOS 沙盒 worker 中执行。只有明确需要无沙盒调试时，才使用 `npm run dev`。

启动后可在设置页选择 Agent Profile、调整基础/高级运行参数，并管理 Chrome 与 JetBrains MCP 连接。这些值保存在本地 `data/config.json`，密钥仍保留在 `.env`。

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

删除文件、安装依赖、执行终端命令等危险操作都需要显式确认。通过 `npm run sandbox` 启动时，沙盒权限边界由 [sandbox.sb](sandbox.sb) 控制。

## 多设备查看

开发服务默认只监听 `127.0.0.1`。需要在局域网访问时，先在 `.env` 设置至少 16 位的 `SAGENT_API_TOKEN`，再显式暴露 Vite：

```bash
openssl rand -hex 24
# 把输出填入 .env 的 SAGENT_API_TOKEN=
VITE_HOST=0.0.0.0 npm run sandbox
```

局域网设备随后可打开 `http://<Mac-IP>:5173`，首次受保护请求会要求输入 Token。独立部署前端时，还需通过 `SAGENT_CORS_ORIGINS` 配置精确来源。

- Agent 运行中，其他设备展示执行流程，并在完成后收到最终结果。
- 聊天历史保存在各自浏览器里，不跨设备共享。
- 同一时间只能运行一个 Agent，新的任务请求会收到 409。
- 配置 Token 后，API、OpenAI 兼容 `/v1` 和截图接口都需要认证；后端监听非 loopback 地址时，没有合规 Token 将拒绝启动。

## 核心工作流

### 多模型 Agent

Agent 模式下，每一步都可以同时调用多个模型。竞速模式采用第一个有效结果并取消其余请求；汇总模式会等待所有选中模型并聚合结果。前端支持选择模型、调整优先级、切换策略。

### Checkpoint 恢复

Agent 每完成一步都会写入 `data/checkpoints/`。如果后端重启且恢复已启用，sagent 会还原上次运行状态，并从下一步继续执行。正常完成的任务会自动清理 checkpoint。

### 跨会话记忆

sagent 会在配置的数据目录下保存项目经验，包括近期任务摘要、压缩后的历史上下文和项目知识。侧边栏记忆面板可以查看、手动压缩或清空这些状态。

### IDE 与浏览器集成

JetBrains IDE MCP 会给 Agent 增加 `ide_list_tools` 和 `ide_call_tool`。Chrome DevTools MCP 会增加 `chrome_list_tools` 和 `chrome_call_tool`。两者都是可选能力，配置方式见 [CONFIGURATION.md](CONFIGURATION.md)。

## 常用命令

```bash
npm run sandbox      # 沙盒 worker 模式启动 server 和 client
npm run dev          # 无沙盒 worker 模式启动 server 和 client
npm run build        # 后端类型检查 + 前端构建
npm run lint         # 运行 ESLint
npm test             # 运行 Vitest 测试
npm run smoke        # 对运行中的服务执行 Agent 冒烟场景
npm run stop         # 停止前后端进程
npm run chrome:mcp   # 启动 Chrome DevTools MCP SSE bridge
```

运行 smoke 测试时，先启动 sagent，再在另一个终端执行 `npm run smoke`。报告会写入 `data/smoke-reports/`，失败用例会打印对应的 `data/traces/` 文件路径。

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
