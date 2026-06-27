<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>Multi-model AI chat + desktop Agent with browser automation, file operations, terminal commands, macOS control, and JetBrains IDE MCP support.</p>
</div>

> **macOS only.** The Agent needs to control the local browser and system, currently tested on Mac only.
>
> Browser automation uses Bun 1.3+ `Bun.WebView`, which runs on the system WebKit backend on macOS.
>
> 🌐 **中文版**: [README_ZH.md](README_ZH.md)

## Quick Start

```bash
git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env  # Fill in your API Key
npm install && cd client && npm install && cd ..
npm run sandbox       # Requires Bun 1.3+
```

Open http://localhost:5173

When the Agent needs your approval, sagent shows a browser desktop notification with **Allow / Reject** buttons (Chromium-based browsers). The first time the Agent requests approval you'll see a banner — click **Enable desktop notifications** and the browser will prompt for permission. On Safari/Firefox the notification still pops but without inline buttons — clicking it focuses sagent so you can decide in the side panel.

## Docker

The Docker image builds the frontend and runs the backend with Bun. It is useful for sharing the server/UI package. Agent features that depend on the macOS desktop, system WebView, or controlling a host browser are still best run natively with `npm run sandbox`.

```bash
cp .env.example .env
# Fill NVIDIA_API_KEY or GEMINI_API_KEY in .env
docker compose up --build
```

Open http://localhost:5173

Manual build/run:

```bash
docker build -t sagent:local .
docker run --env-file .env -p 5173:5173 -v "$(pwd)/data-docker:/app/data" sagent:local
```

## Security: Sandbox Policy

When started with `npm run sandbox`, the UI/API server stays outside the macOS sandbox and each Agent run starts a short-lived worker inside `sandbox-exec`, with permissions controlled by `sandbox.sb` and `PROJECT_DIR` set to that run's project root.

You can customize `sandbox.sb` to adjust the Agent's permission boundary. Modifying the file may cause some Agent functions to lose permission (e.g., unable to access the network, unable to open the browser, etc.).

Dangerous operations (deleting files, installing packages, executing terminal commands) will pop up a confirmation dialog — the Agent cannot proceed without your approval.

## Multi-Device View

Other devices on the LAN (phone, iPad) can open `http://<Mac-IP>:5173` to view the Agent's execution progress in real time.

- **Agent running**: Other devices can only watch the agent execution flow; the chat area is empty until the agent completes
- **Chat history**: Each device is independent; history is not shared
- **Only one Agent at a time**: New requests will receive a 409 error

## Configuration

Edit `.env`:

```bash
# API Keys (fill at least one)
NVIDIA_API_KEY=nvapi-...  # MiniMax, Kimi, Qwen, GLM, DeepSeek, etc.
GEMINI_API_KEY=...

# Agent behavior (optional)
AGENT_MAX_STEPS=128            # Max steps per task, default 8
AGENT_MODEL_TIMEOUT=30         # Per-model timeout in seconds
AGENT_MAX_HISTORY_STEPS=20     # Max history steps sent to LLM (prevents context overflow)
AGENT_MAX_RESULT_CHARS=1000    # Max chars per step result in history
AGENT_MEMORY_MAX_ENTRIES=20    # Memory compaction threshold
AGENT_RESUME=true              # Auto-resume interrupted tasks after backend restart

# Multi-model race (optional)
AGENT_STAGGER_DELAY=3          # Delay between batches in seconds
AGENT_BATCH_SIZE=2             # Models launched per batch
# AGENT_MULTI_MODELS=moonshotai/kimi-k2.5,qwen/qwen3.5-397b-a17b

# JetBrains IDE MCP (optional)
IDE_MCP_ENABLED=true
IDE_MCP_TRANSPORT=sse
IDE_MCP_URL=http://127.0.0.1:6365/sse
IDE_PROJECT_PATH=/path/to/your/project
# Or use stdio copied from the IDE:
# IDE_MCP_TRANSPORT=stdio
# IDE_MCP_COMMAND=npx
# IDE_MCP_ARGS=["-y","@jetbrains/mcp-proxy"]
```

When `IDE_MCP_ENABLED=true`, the Agent exposes two extra tools:

- `ide_list_tools`: discover the MCP tools currently exposed by JetBrains IDE
- `ide_call_tool`: call a specific IDE MCP tool with its argument object

Tip: in JetBrains IDE, open `Settings | Tools | MCP Server`, enable it, then use `Copy SSE Config` or `Copy Stdio Config` and mirror the connection details into `.env`. If your IDE shows a different URL or port than `127.0.0.1:6365/sse`, prefer the IDE-provided value.

## Recovery After Backend Restart

Each completed step is written to `data/checkpoints/` (atomic writes, crash-safe).

When the backend restarts:

- **`AGENT_RESUME=true` (default)**: Automatically detects unfinished checkpoints, restores the last runId and step history, and resumes from the breakpoint. The frontend can also reconnect via SSE after refresh.
- **`AGENT_RESUME=false`**: Clears all checkpoints on startup; does not resume any interrupted tasks.

Successfully completed tasks automatically clean up their checkpoints.

## Common Commands

```bash
npm run build    # Type-check backend and build frontend
npm run sandbox  # Start with sandbox (recommended)
npm run dev      # Start without sandbox
npm run stop     # Stop frontend and backend
```

## Multi-Model Agent

The Agent can invoke multiple models concurrently for each step, picking the fastest result.

- **Race mode**: Models launch in priority order. First valid result wins; remaining are cancelled.
- **Vote mode**: All models run concurrently, results are aggregated by majority vote.
- **Batch race**: `AGENT_BATCH_SIZE` controls models per batch. If the entire batch fails, next batch starts immediately.

Frontend: select multiple models in Agent mode, reorder with arrows to set priority, toggle between race/vote strategies.

## Cross-Session Memory

The Agent accumulates project experience across sessions, persisted in local storage.

- **Conversation records**: Summaries of recent tasks (task, result, models, timestamp)
- **Compacted summary**: LLM-distilled historical summary (deduplicated, up to 2000 chars)
- **Project knowledge**: Directory structure, common paths, user preferences, learnings

Auto-compaction triggers when records exceed `AGENT_MEMORY_MAX_ENTRIES` (default 20).

### Memory Panel

Click the brain icon in the left sidebar to open the memory panel — it's global, not tied to any specific task. You can view conversation history, project knowledge, manually trigger compaction, or clear memory.

```bash
AGENT_MEMORY_MAX_ENTRIES=20  # Compaction threshold
MEMORY_DIR=data              # Memory file storage directory
```
