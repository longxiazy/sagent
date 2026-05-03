<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>Multi-model AI chat + desktop Agent with browser automation, file operations, terminal commands, and macOS control.</p>
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

## Security: Sandbox Policy

When started with `npm run sandbox`, the Agent runs inside the macOS sandbox, with permissions controlled by `sandbox.sb`.

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
# ANTHROPIC_API_KEY=sk-ant-...

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
```

## Recovery After Backend Restart

Each completed step is written to `data/checkpoints/` (atomic writes, crash-safe).

When the backend restarts:

- **`AGENT_RESUME=true` (default)**: Automatically detects unfinished checkpoints, restores the last runId and step history, and resumes from the breakpoint. The frontend can also reconnect via SSE after refresh.
- **`AGENT_RESUME=false`**: Clears all checkpoints on startup; does not resume any interrupted tasks.

Successfully completed tasks automatically clean up their checkpoints.

## Common Commands

```bash
npm run build    # Build frontend
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
