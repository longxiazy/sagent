# 配置说明

sagent 的配置分两层：

- `.env`：后端启动时读取，管理 API Key、供应商地址、服务端口、MCP 连接、沙盒和默认 Agent 行为。修改后通常需要重启后端。
- `data/runtime-config.json`：由前端设置页生成，保存 Agent 行为参数的覆盖值。它会覆盖 `.env` 默认值，并在下一次 Agent 任务生效；点击「恢复默认」会清空该文件。

如果设置了 `MEMORY_DIR`，`runtime-config.json`、记忆、trace、checkpoint、上传文件都会写到这个目录下。

## 最小可用配置

```bash
cp .env.example .env
```

至少填一个模型供应商 Key：

```bash
NVIDIA_API_KEY=nvapi-...
# 或
GEMINI_API_KEY=...
```

然后启动：

```bash
npm run sandbox
```

## API Key 与模型供应商

| 变量 | 说明 | 默认值 / 备注 |
| --- | --- | --- |
| `NVIDIA_API_KEY` | OpenAI 兼容供应商 Key。变量名沿用 NVIDIA，但可配合 `NVIDIA_BASE_URL` 指向其他 OpenAI 兼容服务。 | 与 `GEMINI_API_KEY` 至少填一个 |
| `NVIDIA_BASE_URL` | OpenAI 兼容接口地址。 | `https://integrate.api.nvidia.com/v1` |
| `GEMINI_API_KEY` | Google Gemini 原生 SDK Key。 | 配置后 Gemini 模型会出现在模型列表 |
| `VISION_MODEL` | `image_analyze` 工具使用的视觉模型。 | 使用代码中的默认视觉模型 |
| `AGENT_MULTI_MODELS` | 默认多模型列表，逗号分隔。前端仍可按次选择和排序模型。 | 空 |
| `MODELS` | 旧模型列表变量。 | 已废弃，不再生效；模型列表启动时从供应商接口拉取 |

启动时会向已配置供应商拉取模型列表。至少一家供应商成功即可启动；全部失败时，后端会退出并打印失败原因。

## 服务与存储

| 变量 | 说明 | 默认值 / 备注 |
| --- | --- | --- |
| `PORT` | 后端监听端口。开发模式下前端 Vite 仍是 `5173`，并代理到后端。 | `3001`；Docker 镜像内为 `5173` |
| `HOST` | 后端监听地址。 | `0.0.0.0` |
| `MEMORY_DIR` | 本地数据目录，保存记忆、trace、checkpoint、截图、上传文件、运行时配置。 | `data`；Docker 中为 `/app/data` |
| `HOST_PORT` | `docker compose` 映射到宿主机的端口。 | `5173` |
| `LOG_LEVEL` | 日志等级。 | `info`，可选 `debug` / `info` / `warn` / `error` |

不要提交真实 `.env`。如果 `data/runtime-config.json` 只包含个人偏好，也建议不要提交。

## Agent 行为参数

这些变量作为默认值写在 `.env` 中；前端设置页保存后，会被 `runtime-config.json` 覆盖。

| 变量 | 前端字段 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AGENT_MAX_STEPS` | `maxSteps` | `8` | 单次 Agent 任务最大步数 |
| `AGENT_MODEL_TIMEOUT` | `modelTimeoutSec` | `90` | 单模型单步超时秒数 |
| `AGENT_STAGGER_DELAY` | `staggerDelaySec` | `5` | 多模型竞速批次间隔秒数 |
| `AGENT_BATCH_SIZE` | `batchSize` | `1` | 每批启动的模型数量 |
| `AGENT_OBSERVE_DESKTOP` | `observeDesktop` | `false` | 是否在 Agent 循环中观测 macOS 桌面状态 |
| `AGENT_MAX_HISTORY_STEPS` | `maxHistorySteps` | `20` | 发送给模型的最大历史步数 |
| `AGENT_MAX_RESULT_CHARS` | `maxResultChars` | `8000` | 每步结果写入上下文时保留的最大字符数 |
| `AGENT_MAX_PARALLEL_RESULT_CHARS` | `maxParallelResultChars` | `32000` | 并行模型结果写入上下文时的最大字符数 |
| `AGENT_MEMORY_MAX_ENTRIES` | `memoryMaxEntries` | `20` | 对话记忆触发压缩的记录数阈值 |

前端设置页不会管理 API Key。Key 仍只从 `.env` 读取，修改后需要重启后端。

## Checkpoint 与恢复

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_RESUME` | `true` | 后端重启时是否恢复未完成的 Agent 任务。设置为 `false` 会在启动时清理残留 checkpoint |

checkpoint 写在 `{MEMORY_DIR}/checkpoints/`。任务正常完成后会自动清理。

## 沙盒与 worker

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_SANDBOXED_WORKERS` | `false` | `npm run sandbox` 会自动设为 `true`，让每次 Agent run 进入 worker |
| `AGENT_WORKER_SANDBOX` | `true` | worker 内是否继续使用 macOS `sandbox-exec` |
| `AGENT_HEADLESS` | `false` | 兼容旧配置；当前 WebView 后端会忽略该值 |
| `AGENT_WORKER_CANCEL_GRACE_MS` | 内置值 | 取消 run 后等待 worker 正常结束的时间 |
| `AGENT_WORKER_CANCEL_KILL_GRACE_MS` | 内置值 | 强制结束 worker 前的额外等待时间 |
| `AGENT_SERVER_SHUTDOWN_GRACE_MS` | 内置值 | 服务退出时等待 worker 清理的时间 |

沙盒权限由 [sandbox.sb](sandbox.sb) 控制。调整该文件可能导致网络、浏览器、文件系统等能力失效或放宽。

## JetBrains IDE MCP

启用后，Agent 会增加两个工具：

- `ide_list_tools`：列出 IDE 当前暴露的 MCP 工具。
- `ide_call_tool`：按工具名调用 IDE MCP 工具。

推荐先在 JetBrains IDE 中打开 `Settings | Tools | MCP Server`，启用后复制 SSE 或 stdio 配置。

SSE 示例：

```bash
IDE_MCP_ENABLED=true
IDE_MCP_TRANSPORT=sse
IDE_MCP_URL=http://127.0.0.1:6365/sse
IDE_PROJECT_PATH=/path/to/project
```

也可以拆成 host/port/path：

```bash
IDE_MCP_ENABLED=true
IDE_MCP_TRANSPORT=sse
IDE_MCP_HOST=127.0.0.1
IDE_MCP_PORT=6365
IDE_MCP_SSE_PATH=/sse
IDE_PROJECT_PATH=/path/to/project
```

stdio 示例：

```bash
IDE_MCP_ENABLED=true
IDE_MCP_TRANSPORT=stdio
IDE_MCP_COMMAND=npx
IDE_MCP_ARGS=["-y","@jetbrains/mcp-proxy"]
IDE_PROJECT_PATH=/path/to/project
```

可用变量：

| 变量 | 说明 |
| --- | --- |
| `IDE_MCP_ENABLED` | 显式启用 IDE MCP |
| `IDE_MCP_TRANSPORT` | `sse` 或 `stdio` |
| `IDE_MCP_URL` / `IDE_MCP_SSE_URL` | SSE 完整地址，优先级高于 host/port/path |
| `IDE_MCP_MESSAGES_URL` | MCP messages endpoint，IDE 提供时再填 |
| `IDE_MCP_HOST` | SSE host |
| `IDE_MCP_PORT` | SSE port |
| `IDE_MCP_SSE_PATH` | SSE path |
| `IDE_PROJECT_PATH` / `IDE_MCP_PROJECT_PATH` | 默认项目路径 |
| `IDE_MCP_CWD` | stdio transport 的工作目录 |
| `IDE_MCP_COMMAND` | stdio command |
| `IDE_MCP_ARGS` | stdio args，JSON 数组或可解析字符串 |

如果 IDE 显示的地址或端口与示例不同，以 IDE 复制出来的配置为准。

## Chrome DevTools MCP

启用后，Agent 会增加：

- `chrome_list_tools`：刷新或查看 Chrome MCP 工具列表。
- `chrome_call_tool`：调用 Chrome DevTools MCP 工具。

sandbox 模式下推荐另开一个非 sandbox 终端启动 bridge：

```bash
npm run chrome:mcp
```

然后在 `.env` 中配置：

```bash
CHROME_MCP_ENABLED=true
CHROME_MCP_TRANSPORT=sse
CHROME_MCP_HOST=127.0.0.1
CHROME_MCP_PORT=3099
CHROME_MCP_SSE_PATH=/sse
```

可用变量：

| 变量 | 说明 |
| --- | --- |
| `CHROME_MCP_ENABLED` | 显式启用 Chrome MCP |
| `CHROME_MCP_TRANSPORT` | 当前使用 SSE |
| `CHROME_MCP_URL` | SSE 完整地址，优先级高于 host/port/path |
| `CHROME_MCP_MESSAGES_URL` | MCP messages endpoint，服务提供时再填 |
| `CHROME_MCP_HOST` | SSE host，默认 `127.0.0.1` |
| `CHROME_MCP_PORT` | SSE port，默认 `3099` |
| `CHROME_MCP_SSE_PATH` | SSE path，默认 `/sse` |
| `CHROME_MCP_KEEP_OPEN` | 设为 `true` 时，Agent run 结束后保留 MCP SSE client |
| `CHROME_MCP_KEEP_TABS` | 设为 `true` 时，Agent run 结束后保留本次打开的 Chrome tab |
| `CHROME_MCP_NAVIGATE_TIMEOUT_MS` | `navigate_page` 默认超时，默认 `25000` |
| `CHROME_MCP_TOOL_TIMEOUT_MS` | Chrome MCP 工具调用超时，默认 `60000` |

bridge 自身也支持这些变量：

| 变量 | 说明 |
| --- | --- |
| `CHROME_MCP_BRIDGE_HOST` | bridge 监听 host，默认 `127.0.0.1` |
| `CHROME_MCP_BRIDGE_PORT` | bridge 监听 port，默认 `3099` |
| `CHROME_MCP_BRIDGE_COMMAND` | bridge 启动的 MCP 命令，默认 `chrome-devtools-mcp` |
| `CHROME_MCP_BRIDGE_ARGS` | 追加传给 bridge command 的参数 |

## Docker 配置

`docker-compose.yml` 会读取 `.env`，并把容器内数据目录挂到 `./data-docker`。

常用方式：

```bash
cp .env.example .env
docker compose up --build
```

修改宿主机端口：

```bash
HOST_PORT=8080 docker compose up --build
```

手动运行时需要传入 env file 和数据卷：

```bash
docker run --env-file .env -p 5173:5173 -v "$(pwd)/data-docker:/app/data" sagent:local
```

## 常见配置组合

仅使用 OpenAI 兼容供应商：

```bash
NVIDIA_API_KEY=your-key
NVIDIA_BASE_URL=https://your-compatible-endpoint/v1
```

仅使用 Gemini：

```bash
GEMINI_API_KEY=your-key
```

开启断点恢复和较长任务：

```bash
AGENT_RESUME=true
AGENT_MAX_STEPS=64
AGENT_MODEL_TIMEOUT=120
```

开启多模型竞速默认列表：

```bash
AGENT_MULTI_MODELS=moonshotai/kimi-k2.5,qwen/qwen3.5-397b-a17b
AGENT_BATCH_SIZE=2
AGENT_STAGGER_DELAY=1
```
