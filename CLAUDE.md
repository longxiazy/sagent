# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AI API proxy chat application supporting both NVIDIA and Anthropic Claude models, with a desktop AI agent that can automate browsers, files, terminals, and macOS. The frontend is React/Vite, the backend is Express, and the agent system uses an observe-decide-execute loop with policy-based authorization. Available models include Claude Opus 4.7/Sonnet 4.6/Haiku 4.5 and NVIDIA models (MiniMax, Llama, Kimi, Gemma).

## Commands

```bash
npm run dev        # Start both Express server (3001) and Vite dev server
npm run server     # Express server only
npm run devserver  # Express server with --watch
npm run client     # Vite dev server only

cd client && npm run build   # Production build
cd client && npm run lint    # ESLint (flat config, JSX only)
cd worker && npm test        # Cloudflare Worker Vitest tests
```

## Architecture

```
client/            React frontend (Vite, plain JSX, no TypeScript)
server.js          Express backend — API proxy + Agent orchestration
routes/            API routes (chat, agent, completions)
helpers/           Shared utilities (logger, retry, run-store, streaming)
agent/             Desktop agent system
├── core/          Engine: runtime.js (loop), ai-client.js (LLM client),
│                 tool-definitions.js (schemas), planner.js (NVIDIA),
│                 nvidia-response-parsers.js, schemas.js, router.js
├── chat/          Chat-mode tools (chat-tools.js, chat-tool-executor.js)
├── policy/        classify.js (action risk levels), approvals.js
├── desktop/       agent.js (orchestrator)
└── tools/         browser/, fs/, terminal/, macos/ (each with execute.js, observe.js)
worker/            Cloudflare Worker (experimental)
```

### Backend API

- `POST /api/chat` — Streaming chat (routes to NVIDIA or Anthropic based on model, SSE)
- `POST /api/agent` — Agent orchestration (SSE stream with status/step/done/error/approval_required events)
- `POST /api/agent/approvals` — Resolve pending approvals `{ runId, approvalId, decision }`
- `/v1/chat/completions` — OpenAI-compatible endpoint (supports both NVIDIA and Claude models)
- `GET /v1/models` — Lists all available models

### Agent Execution Loop (`agent/core/runtime.js`)

```
observe → decide (LLM) → authorize (policy) → execute (tool) → repeat
```

The LLM planner routes to either OpenAI (NVIDIA, JSON output mode) or Anthropic (Claude, native tool use). The output is normalized to `{ rationale, action: { tool, type, ... } }` regardless of provider. Actions are classified as `safe`, `confirm`, or `blocked`. User approval is required for `confirm` actions.

### Action Types

- `browser` — navigate, click, type, wait (Playwright)
- `fs` — list_dir, read_file, write_file
- `terminal` — run_safe (whitelist-only), run_confirmed
- `macos` — open_app, click_at, type_text, press_key, capture_screen, list_windows
- `core.finish` — task completion

### Frontend Architecture

- `client/src/App.jsx` — Main SPA (~1400 lines), handles Chat and Agent modes
- SSE streaming with AbortController for cancellation
- Session persistence via localStorage
- UI mode toggle between plain chat and agent task execution
- Markdown + syntax highlighting for responses, thinking blocks support

## Key Patterns

- **Snake_case** for functions (`createRunId`, `streamSseJson`), **PascalCase** for React components
- All LLM responses and comments are in **Chinese**
- Browser elements identified by `data-agent-node-id` attribute injected into DOM
- Terminal `run_safe` uses an allowlist; `run_confirmed` allows anything but requires user approval
- `agent/policy/classify.js` defines action risk levels — modify this to change which actions require approval

## Environment

```env
NVIDIA_API_KEY=nvapi-...     # Required for NVIDIA models
ANTHROPIC_API_KEY=sk-ant-... # Required for Claude models
PORT=3001                    # Default server port
```

## Important Files

- `server.js` — Backend entry, all API routes
- `agent/core/ai-client.js` — Unified AI client abstraction (NVIDIA + Anthropic)
- `agent/core/tool-definitions.js` — Agent tool schema definitions
- `client/src/App.jsx` — Frontend state, SSE handling, UI
- `agent/core/runtime.js` — Agent loop implementation
- `agent/core/planner.js` — JSON-based LLM decision-making (NVIDIA)
- `agent/core/schemas.js` — Action normalization and validation
- `agent/policy/classify.js` — Action authorization thresholds
- `agent/tools/macos/execute.js` — macOS automation (AppleScript + native helper binary)
