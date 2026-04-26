<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>多模型 AI 聊天 + 桌面 Agent，支持浏览器自动化、文件操作、终端命令、macOS 控制。</p>
</div>

> **仅支持 macOS**。Agent 需要操控本地浏览器和系统，目前只在 Mac 上测试通过。
>
> 前端适配移动端 — 手机、平板、电脑浏览器都能用，随时随地查看 Agent 进度、继续对话。

## 快速开始

```bash
git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env                    # 编辑填入 API Key
npm install && cd client && npm install && cd ..
npm run sandbox
```

打开 http://localhost:5173

## 安全：沙盒策略

通过 `npm run sandbox` 启动时，Agent 在 macOS 沙盒内运行，权限由 `sandbox.sb` 文件控制。

你可以自定义 `sandbox.sb` 来调整 Agent 的权限边界。修改该文件可能导致 Agent 部分功能无权限执行（如无法访问网络、无法打开浏览器等）。

危险操作（删文件、装包、执行终端命令）会弹窗确认，你不点同意 Agent 就没法继续。

## 多设备查看

局域网内其他设备（手机、iPad）打开 `http://<Mac的IP>:5173` 可以实时查看 Agent 的执行进度。

- **Agent 运行中**：其他设备进入后只能看 agent 执行流程，聊天区为空，等待 agent 完成后显示最终结果
- **聊天记录**：各设备独立，不共享历史会话
- **同时只能跑一个 Agent**：新请求会收到 409 提示

## 配置

编辑 `.env`：

```bash
# API Key（至少填一个）
NVIDIA_API_KEY=nvapi-...              # MiniMax、Kimi、Qwen、GLM、DeepSeek 等

# Agent 行为（可选）
AGENT_MAX_STEPS=32         # 单次任务最大步数，默认 32
AGENT_RESUME=true          # 后端重启后自动恢复未完成的 Agent 任务

```

## 后端重启恢复

Agent 每完成一步都会将状态写入 `data/checkpoints/` 目录（原子写入，防崩溃损坏）。

当后端进程重启时：

- **`AGENT_RESUME=true`（默认）**：自动检测未完成的 checkpoint，恢复上次的 runId、步骤历史，从断点继续执行。前端刷新后也能通过 SSE 重连接上恢复中的任务。
- **`AGENT_RESUME=false`**：启动时清除所有 checkpoint，不恢复任何中断的任务。

正常运行完成的任务会自动清理 checkpoint，无需手动维护。

## 常用命令

```bash
npm run build        # 构建前端

npm run sandbox      # 沙盒模式启动（推荐）
npm run dev          # 无沙盒启动

npm run stop         # 停止前后端
```
