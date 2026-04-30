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
# 安装 Bun（必需，>= 1.3）
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env                    # 编辑填入 API Key
npm install && cd client && npm install && cd ..
npm run dev
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
AGENT_MAX_STEPS=128        # 单次任务最大步数，默认 8
AGENT_MODEL_TIMEOUT=30     # 单模型超时秒数
AGENT_MEMORY_MAX_ENTRIES=20  # 记忆压缩阈值
AGENT_RESUME=true          # 后端重启后自动恢复未完成的 Agent 任务
AGENT_HEADLESS=false       # 兼容旧配置，WebView 后端会忽略该值

# 多模型竞速（可选）
AGENT_STAGGER_DELAY=3      # 批次间隔秒数
AGENT_BATCH_SIZE=2         # 每批启动模型数
# AGENT_MULTI_MODELS=moonshotai/kimi-k2.5,qwen/qwen3.5-397b-a17b
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

## 多模型 Agent

Agent 每步可并发调用多个模型，取最快结果。

- **竞速模式**：模型按优先级顺序启动，首个立即运行，后续间隔 `AGENT_STAGGER_DELAY` 秒依次加入。第一个有效结果直接采用，其余取消。超时或失败的模型自动加入黑名单。
- **汇总模式**：所有模型同时并发，结果按多数投票聚合。
- **分批竞速**：设置 `AGENT_BATCH_SIZE` 控制每批启动几个模型。整批全部失败后，下一批跳过延迟立即启动。

前端：Agent 模式下选择多个模型，用箭头调整优先级顺序，切换竞速/汇总策略。Trace 面板展示各模型状态（等待中、思考中、采纳、已取消），任务完成后显示实际参与的模型。

## 跨会话记忆

Agent 自动积累项目经验和对话历史，跨会话持久化，让 Agent "记住"之前做过什么。

### 存储内容

- **对话记录**：最近 N 次任务的摘要（任务 → 结果 + 使用的模型 + 时间戳）
- **压缩摘要**：LLM 提炼的历史摘要（去重合并，上限 2000 字）
- **项目知识**：目录结构、常用路径、用户偏好、经验积累

### 自动压缩

- 当对话记录超过 `AGENT_MEMORY_MAX_ENTRIES`（默认 20）时自动触发
- 将全部历史条目交给 LLM 提炼为摘要（去重合并），保留最近 N 条
- 压缩模型自动选择本轮成功次数最多的模型
- 异步执行，不阻塞 Agent 响应
- LLM 不可用时退化为文本拼接

### 记忆面板

点击 Agent 面板顶部的 🧠 图标可打开记忆面板，查看：

- **对话** Tab：历史摘要（含压缩时间）+ 最近对话列表（任务、结果、模型、时间）
- **知识** Tab：项目结构、常用路径、偏好、经验
- **手动压缩**：点击底部"压缩历史"按钮触发 LLM 压缩

### 相关配置

```bash
AGENT_MEMORY_MAX_ENTRIES=20    # 对话记录压缩阈值，超过后触发压缩
MEMORY_DIR=data               # 记忆文件存储目录
```
