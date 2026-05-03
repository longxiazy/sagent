<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>多模型 AI 聊天 + 桌面 Agent，支持浏览器自动化、文件操作、终端命令、macOS 控制。</p>
</div>

> **仅支持 macOS**。Agent 需要操控本地浏览器和系统，目前只在 Mac 上测试通过。
>
> 浏览器自动化基于 Bun 1.3+ 内置 `Bun.WebView`，macOS 会直接使用系统 WebKit。
>
> 前端适配移动端 — 手机、平板、电脑浏览器都能用，随时随地查看 Agent 进度、继续对话。

## 快速开始

```bash
git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env                    # 编辑填入 API Key
npm install && cd client && npm install && cd ..
npm run sandbox                         # 需要 Bun 1.3+
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
# ANTHROPIC_API_KEY=sk-ant-...

# Agent 行为（可选）
AGENT_MAX_STEPS=128              # 单次任务最大步数，默认 8
AGENT_MODEL_TIMEOUT=30           # 单模型超时秒数
AGENT_MAX_HISTORY_STEPS=20       # 发送给 LLM 的最大历史步数（防止上下文溢出）
AGENT_MAX_RESULT_CHARS=1000      # 每步结果保留的最大字符数
AGENT_MEMORY_MAX_ENTRIES=20      # 记忆压缩阈值
AGENT_RESUME=true                # 后端重启后自动恢复未完成的 Agent 任务

# 多模型竞速（可选）
AGENT_STAGGER_DELAY=3            # 批次间隔秒数
AGENT_BATCH_SIZE=2               # 每批启动模型数
# AGENT_MULTI_MODELS=moonshotai/kimi-k2.5,qwen/qwen3.5-397b-a17b
```

## 后端重启恢复

Agent 每完成一步都会将状态写入 `data/checkpoints/` 目录（原子写入，防崩溃损坏）。

当后端进程重启时：

- **`AGENT_RESUME=true`（默认）**：自动检测未完成的 checkpoint，从断点继续执行。前端刷新后也能通过 SSE 重连接上。
- **`AGENT_RESUME=false`**：启动时清除所有 checkpoint，不恢复任何中断的任务。

正常运行完成的任务会自动清理 checkpoint，无需手动维护。

## 常用命令

```bash
npm run build        # 构建前端
npm run sandbox      # 沙盒模式启动（推荐）
npm run dev          # 无沙盒启动
npm run stop         # 停止前后端
```

## 多模型 Agent

Agent 每步可并发调用多个模型，取最快结果。

- **竞速模式**：模型按优先级顺序启动。第一个有效结果直接采用，其余取消。
- **汇总模式**：所有模型同时并发，结果按多数投票聚合。
- **分批竞速**：`AGENT_BATCH_SIZE` 控制每批启动几个模型。整批全部失败后，下一批跳过延迟立即启动。

前端：Agent 模式下选择多个模型，用箭头调整优先级顺序，切换竞速/汇总策略。

## 跨会话记忆

Agent 自动积累项目经验和对话历史，跨会话持久化。

- **对话记录**：最近 N 次任务的摘要（任务、结果、模型、时间戳）
- **压缩摘要**：LLM 提炼的历史摘要（去重合并，上限 2000 字）
- **项目知识**：目录结构、常用路径、用户偏好、经验积累

当对话记录超过 `AGENT_MEMORY_MAX_ENTRIES`（默认 20）时自动触发压缩。

### 记忆面板

点击左侧会话列表顶部的 brain 图标可打开记忆面板 — 它是全局的，不属于任何任务。可以查看对话历史、项目知识、手动触发压缩或清空记忆。

```bash
AGENT_MEMORY_MAX_ENTRIES=20    # 对话记录压缩阈值
MEMORY_DIR=data                # 记忆文件存储目录
```
