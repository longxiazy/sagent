# sagent

多模型 AI 聊天 + 桌面 Agent，支持浏览器自动化、文件操作、终端命令、macOS 控制。

## 快速开始

```bash
git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env                    # 编辑填入 API Key
npm install && cd client && npm install && cd ..
npm run sandbox
```

打开 http://localhost:5173

## 配置

编辑 `.env`：

```bash
# API Key（必填，支持 MiniMax、Kimi、Qwen、GLM、DeepSeek 等模型）
NVIDIA_API_KEY=nvapi-...

# Agent 行为（可选）
AGENT_MAX_STEPS=32         # 单次任务最大步数，默认 32
AGENT_HEADLESS=false       # true=无头浏览器，false=显示浏览器窗口
AGENT_RESUME=true          # 后端重启后自动恢复未完成的 Agent 任务

# Anthropic Claude（可选，用于 Claude 模型）
ANTHROPIC_API_KEY=sk-ant-...

# Chrome 路径（可选，默认自动检测）
CHROME_PATH=auto
```

## 后端重启恢复

Agent 每完成一步都会将状态写入 `data/checkpoints/` 目录（原子写入，防崩溃损坏）。

当后端进程重启时：

- **`AGENT_RESUME=true`（默认）**：自动检测未完成的 checkpoint，恢复上次的 runId、步骤历史，从断点继续执行。前端刷新后也能通过 SSE 重连接上恢复中的任务。
- **`AGENT_RESUME=false`**：启动时清除所有 checkpoint，不恢复任何中断的任务。

正常运行完成的任务会自动清理 checkpoint，无需手动维护。

## 常用命令

```bash
npm run sandbox      # 沙盒模式启动（推荐）
npm run dev          # 无沙盒启动
npm run build        # 构建前端
npm run stop         # 停止前后端
```
