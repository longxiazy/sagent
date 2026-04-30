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
AGENT_MAX_STEPS=128          # Max steps per task, default 8
AGENT_MODEL_TIMEOUT=30       # Per-model timeout in seconds
AGENT_MEMORY_MAX_ENTRIES=20  # Memory compaction threshold
AGENT_RESUME=true            # Auto-resume interrupted tasks after backend restart
AGENT_HEADLESS=false         # Legacy compatibility; ignored by the WebView backend

# Multi-model race (optional)
AGENT_STAGGER_DELAY=3        # Delay between batches in seconds
AGENT_BATCH_SIZE=2           # Models launched per batch
# AGENT_MULTI_MODELS=moonshotai/kimi-k2.5,qwen/qwen3.5-397b-a17b
```

## Recovery After Backend Restart

Each completed step is written to `data/checkpoints/` (atomic writes, crash-safe).

When the backend restarts:

- **`AGENT_RESUME=true` (default)**: Automatically detects unfinished checkpoints, restores the last runId and step history, and resumes from the breakpoint. The frontend can also reconnect via SSE after refresh to resume the task.
- **`AGENT_RESUME=false`**: Clears all checkpoints on startup; does not resume any interrupted tasks.

Successfully completed tasks automatically clean up their checkpoints — no manual maintenance needed.

## Common Commands

```bash
npm run build  # Build frontend
npm run sandbox  # Start with sandbox (recommended)
npm run dev   # Start without sandbox
npm run stop  # Stop frontend and backend
```

## Multi-Model Agent

The Agent can invoke multiple models concurrently for each step, picking the fastest result.

- **Race mode**: Models launch in priority order with a configurable stagger delay. First valid result wins; remaining models are cancelled. Models that fail or timeout are blacklisted for subsequent steps.
- **Vote mode**: All models run concurrently, results are aggregated by majority vote.
- **Batch race**: Set `AGENT_BATCH_SIZE` to launch N models at a time. If the entire batch fails, the next batch starts immediately (skipping the stagger delay).

Frontend: select multiple models in Agent mode, reorder with arrows to set priority, toggle between race/vote strategies. The trace panel shows each model's status (pending, thinking, winner, cancelled).

## Cross-Session Memory

The Agent automatically accumulates project experience and conversation history, persisted across sessions so it "remembers" what was done before.

### What's Stored

- **Conversation records**: Summaries of the last N tasks (task → result + models used + timestamp)
- **Compacted summary**: LLM-distilled historical summary (deduplicated, merged, up to 2000 chars)
- **Project knowledge**: Directory structure, common paths, user preferences, learnings

### Auto-Compaction

- Triggered when conversation records exceed `AGENT_MEMORY_MAX_ENTRIES` (default 20)
- All entries are sent to an LLM for deduplication and summarization; only the most recent N entries are kept
- The compaction model is automatically selected based on the most successful model in the current session
- Runs asynchronously — does not block Agent responses
- Falls back to text concatenation if LLM is unavailable

### Memory Panel

Click the 🧠 icon in the Agent panel header to open the memory panel:

- **Conversation** tab: Historical summary (with compaction timestamp) + recent conversation list (task, result, models, time)
- **Knowledge** tab: Project structure, common paths, preferences, learnings
- **Manual compact**: Click "Compact History" at the bottom to trigger LLM compaction

### Related Configuration

```bash
AGENT_MEMORY_MAX_ENTRIES=20  # Compaction threshold — triggers when exceeded
MEMORY_DIR=data             # Directory for memory file storage
```