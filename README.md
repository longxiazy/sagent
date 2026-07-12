<div align="center">
  <img src="client/public/favicon.svg" width="64" height="64" alt="sagent logo">
  <h1>sagent</h1>
  <p>A local AI workspace for multi-model chat and desktop Agent runs.</p>
</div>

> sagent is built around macOS desktop automation. The web UI and API can be packaged with Docker, but the full Agent experience depends on macOS, Bun 1.3+ `Bun.WebView`, and local system permissions.
>
> Chinese documentation: [README_ZH.md](README_ZH.md)
>
> Environment variables and runtime settings: [CONFIGURATION.md](CONFIGURATION.md)
>
> System design: [ARCHITECTURE.md](ARCHITECTURE.md)

## Overview

sagent combines a React web UI, a Bun/Express backend, and a tool-using Agent runtime. It can chat with multiple model providers, run desktop automation, operate files and terminals, inspect browser pages, call JetBrains IDE MCP tools, and preserve project memory between sessions.

The project is designed for local use: you choose a project workspace, start an Agent task, approve sensitive operations, and watch each step stream back into the UI.

## Highlights

- Multi-model chat and Agent mode with race or vote strategies.
- macOS desktop control, screenshots, browser automation, and optional Chrome DevTools MCP integration.
- File, terminal, search, vision, IDE MCP, and browser tools behind an approval-aware runtime.
- Sandboxed Agent workers when launched with `npm run sandbox`.
- Project-scoped memory, traces, uploads, checkpoints, and run recovery.
- Mobile-friendly progress view for devices on the same LAN.
- Smoke tests and trace files for validating Agent behavior after changes.

## Requirements

- macOS for full desktop Agent capabilities.
- Bun 1.3+.
- Node.js and npm for installing dependencies and building the React client.
- At least one model provider API key. See [CONFIGURATION.md](CONFIGURATION.md).
- A Chromium-based browser is recommended for approval notifications with inline buttons.

## Quick Start

```bash
git clone https://github.com/longxiazy/sagent
cd sagent
cp .env.example .env
npm install
cd client && npm install && cd ..
npm run sandbox
```

Edit `.env` before starting if you have not added an API key yet. Open http://localhost:5173 when the dev server is ready.

`npm run sandbox` starts the UI/API server normally and runs each Agent task in a short-lived macOS sandboxed worker. Use `npm run dev` only when you intentionally want the non-sandboxed development mode.

After startup, use Settings to choose an Agent profile, edit basic or advanced runtime limits, and manage Chrome/JetBrains MCP connections. These values are stored locally in `data/config.json`; secrets remain in `.env`.

## Docker

Docker builds the frontend and serves the UI/API from one Bun process. It is useful for sharing the server/UI package, but desktop automation, system WebView access, and host browser control are still best run natively on macOS.

```bash
cp .env.example .env
openssl rand -hex 24
# Paste the output into SAGENT_API_TOKEN= in .env.
docker compose up --build
```

Open http://localhost:5173.

Manual build and run:

```bash
docker build -t sagent:local .
docker run --env-file .env -p 5173:5173 -v "$(pwd)/data-docker:/app/data" sagent:local
```

## Agent Safety

When the Agent needs approval, sagent shows an in-app approval panel and a browser desktop notification. Chromium-based browsers support inline Allow/Reject buttons; Safari and Firefox still show the notification, and clicking it returns focus to sagent.

Dangerous operations such as deleting files, installing packages, or executing terminal commands require explicit approval. The sandbox boundary is controlled by [sandbox.sb](sandbox.sb) when running with `npm run sandbox`.

## Multi-Device View

The default dev server only listens on `127.0.0.1`. To share it on the LAN, generate a token in `.env`, then explicitly expose Vite:

```bash
openssl rand -hex 24
# Paste the output into SAGENT_API_TOKEN= in .env.
VITE_HOST=0.0.0.0 npm run sandbox
```

Devices on the same LAN can then open `http://<Mac-IP>:5173`. The first protected request prompts for the token. For a separately hosted frontend, list its exact origin in `SAGENT_CORS_ORIGINS`.

- While an Agent run is active, secondary devices show the execution flow and receive the final result when it completes.
- Chat history is local to each browser/device.
- Only one Agent run can execute at a time; additional requests receive a 409 response.
- API, OpenAI-compatible `/v1`, and screenshot routes require authentication whenever `SAGENT_API_TOKEN` is configured. Non-loopback backend listeners refuse to start without one.

## Core Workflows

### Multi-Model Agent

Agent mode can call multiple models for each step. In race mode, the first valid result wins and the remaining requests are cancelled. In vote mode, all selected models run and the result is aggregated. The UI lets you select models, reorder priority, and switch strategies per run.

### Checkpoint Recovery

Each completed Agent step is written to `data/checkpoints/`. If the backend restarts and recovery is enabled, sagent restores the last run state and continues from the next step. Completed runs clean up their checkpoints automatically.

### Cross-Session Memory

sagent stores project experience under the configured data directory. Memory includes recent task summaries, compacted historical context, and project knowledge. The memory panel in the sidebar lets you inspect, compact, or clear that state.

### IDE And Browser Integrations

JetBrains IDE MCP adds `ide_list_tools` and `ide_call_tool` to the Agent. Chrome DevTools MCP adds browser inspection and control through `chrome_list_tools` and `chrome_call_tool`. Both integrations are optional and documented in [CONFIGURATION.md](CONFIGURATION.md).

## Common Commands

```bash
npm run sandbox      # Start server and client with sandboxed Agent workers
npm run dev          # Start server and client without sandboxed workers
npm run build        # Type-check backend and build frontend
npm run lint         # Run ESLint
npm test             # Run Vitest tests
npm run smoke        # Run Agent smoke scenarios against a running server
npm run stop         # Stop frontend and backend processes
npm run chrome:mcp   # Start the Chrome DevTools MCP SSE bridge
```

For smoke tests, start sagent first, then run `npm run smoke` in another terminal. Reports are written to `data/smoke-reports/`, and failed cases point to their trace files under `data/traces/`.

## Project Layout

```text
agent/      Agent runtime, providers, tools, policy, workers
routes/     Express API routes
helpers/    Shared server helpers and stores
client/     React/Vite frontend
scripts/    Smoke tests, stop script, Chrome MCP bridge
test/       Vitest and integration tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the backend, Agent, worker, configuration and persistence flows, and [client/ARCHITECTURE.md](client/ARCHITECTURE.md) for the React client.
