# CubeN

N 倍智能 · 石破天惊 · 传说级 AI Agent

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

编辑 `.env`，填入 API Key：

```bash
NVIDIA_API_KEY=nvapi-...                # MiniMax、Kimi、Qwen、GLM、DeepSeek 等
```

## 常用命令

```bash
npm run sandbox      # 沙盒模式启动（推荐）
npm run dev          # 无沙盒启动
npm run build        # 构建前端
npm run stop         # 停止前后端
```
