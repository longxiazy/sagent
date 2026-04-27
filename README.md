<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>Multi-model AI chat + desktop Agent with browser automation, file operations, terminal commands, and macOS control.</p>
</div>

> **macOS only.** The Agent needs to control the local browser and system, currently tested on Mac only.
>
> 🌐 **中文版**: [README_ZH.md](README_ZH.md)

## Quick Start

```bash
git clone https://github.com/longxiazy/sagent && cd sagent
cp .env.example .env  # Fill in your API Key
npm install && cd client && npm install && cd ..
npm run sandbox
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

# Agent behavior (optional)
AGENT_MAX_STEPS=32   # Max steps per task, default 8
AGENT_RESUME=true    # Auto-resume interrupted tasks after backend restart
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