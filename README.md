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

sagent combines a React web UI, a Bun/Express backend, and a tool-using Agent runtime. It can chat with multiple model providers, run desktop automation, operate files and terminals, inspect browser pages, call MCP tools, and preserve project memory between sessions.

The project is designed for local use: you choose a project workspace, start an Agent task, approve sensitive operations, and watch each step stream back into the UI.

## Highlights

- Multi-model chat and Agent mode with race, vote, or progressive strategies.
- macOS desktop observation, screenshots, browser automation, and optional Chrome DevTools MCP integration.
- File, terminal, search, vision, MCP, and browser tools behind an approval-aware runtime.
- Configurable short-lived Agent workers, with optional macOS sandboxing.
- Project-scoped memory, traces, uploads, and session rollback snapshots.
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
npm run dev
```

Edit `.env` before starting if you have not added an API key yet. Open http://localhost:5173 when the dev server is ready.

`npm run dev` starts the UI/API development servers. By default, each Agent task runs in a short-lived Worker; on macOS, the Worker Sandbox option additionally applies `sandbox.sb`. The Worker and Sandbox switches live under Settings → Agent → Advanced and take effect after restarting the backend.

After startup, use Settings to choose an Agent profile, edit basic or advanced runtime limits, and manage Chrome or generic MCP connections. These values are stored locally in `data/config.json`; secrets remain in `.env`.

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

Dangerous operations such as deleting files, installing packages, or executing terminal commands require explicit approval. When Worker Sandbox is enabled on macOS, its boundary is controlled by [sandbox.sb](sandbox.sb).

## Multi-Device View

The default dev server only listens on `127.0.0.1`. To share it on the LAN, generate a token in `.env`, then explicitly expose Vite:

```bash
openssl rand -hex 24
# Paste the output into SAGENT_API_TOKEN= in .env.
VITE_HOST=0.0.0.0 npm run sandbox
```

Devices on the same LAN can then open `http://<Mac-IP>:5173`. The first protected request prompts for the token. For a separately hosted frontend, list its exact origin in `SAGENT_CORS_ORIGINS`.

- While an Agent run is active, secondary devices show the execution flow and receive the final result when it completes.
- Normal chat history is stored by the backend under the configured data directory and is visible to authenticated devices; Private mode conversations are not persisted.
- Only one Agent run can execute at a time; additional requests receive a 409 response.
- API, OpenAI-compatible `/v1`, and screenshot routes require authentication whenever `SAGENT_API_TOKEN` is configured. Non-loopback backend listeners refuse to start without one.

## Core Workflows

### Multi-Model Agent

Agent mode can call multiple models for each step. In race mode, the first valid result wins and the remaining requests are cancelled. In vote mode, all selected models run and successful decisions are aggregated. Progressive mode starts with the primary model, then lets the remaining models join the race if it is slow or fails. The UI lets you select models, reorder priority, and switch strategies per run.

### Session Rollback

Each step of a normal Agent run writes a health snapshot under that run's data directory in `session-checkpoints/`, letting you manually roll a running task back to an earlier step. Cancelling a run clears its snapshots; Private mode creates none, so rollback is unavailable for that run. The backend does not resume interrupted runs after a restart.

### Cross-Session Memory

sagent stores project experience under the configured data directory. Memory includes recent task summaries, compacted historical context, and project knowledge. The memory panel in the sidebar lets you inspect, compact, or clear that state.

### Browser And MCP Integrations

The built-in Browser is read-only and is limited to navigation and content extraction. The “Private mode” toggle in the composer gives the built-in Browser a disposable profile for each task and removes its cookies and LocalStorage during normal task cleanup; it also skips persistence of chat sessions, app/run logs, LLM logs, traces, session snapshots, Worker logs, and sagent-managed screenshots. This isolation does not extend to external Chrome MCP: its browser profile and session are neither isolated nor cleared by Private mode. All interactive web operations—including clicking, typing, login, form submission, upload, and download—are delegated to Chrome DevTools MCP through `chrome_list_tools` and `chrome_call_tool`. Generic MCP servers (including `codex mcp-server`) are exposed through `mcp_list_servers`, `mcp_list_tools`, and `mcp_call_tool`. All integrations are optional and documented in [CONFIGURATION.md](CONFIGURATION.md).

### OpenTelemetry Traces

Every Agent run is recorded as an OpenTelemetry span tree: a chat session is one trace, each run within it is a root span, and each step expands into `observe`, one `chat` span per model consulted, and `execute_tool`. Attributes follow the GenAI semantic conventions, so the data works with any standard tool — Jaeger, Zipkin, Grafana Tempo, or a hosted backend.

Traces are written as JSONL under each project's `traces/` directory and carry W3C-compliant identifiers. Convert them to OTLP/JSON with:

```bash
npm run trace:otlp -- <runId> --pretty
```

Output lands in `data/otlp-exports/`. Use `--all` to convert every recorded run, and `--project <id>` to select a project scope.

By default spans carry only structured metadata — tool names, statuses, token counts, durations — because the GenAI conventions treat prompts and outputs as sensitive and require opt-in. Add `--content` to also export the task text, model rationale, tool arguments and tool results:

```bash
npm run trace:otlp -- <runId> --content --max-content 2000
```

Nothing is lost by the default: full content always remains in the trace JSONL and is regenerated on demand. Credentials are redacted before traces are written, but task text and page content are not — review before pushing to a shared backend.

To view the waterfall, start any OTLP-compatible collector and push to it. Jaeger is the quickest:

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

```bash
npm run trace:otlp -- --all --endpoint http://localhost:4318/v1/traces
```

Then open `http://localhost:16686` and search for the `sagent` service. Private-mode runs persist no trace and therefore export nothing.

## Common Commands

```bash
npm run dev          # Start the API server and Vite client; runner mode comes from Settings/config
npm run prod         # Start the API server (and serve client/dist when it exists)
npm run build        # Type-check backend and build frontend
npm run lint         # Run ESLint
npm test             # Run Vitest tests
npm run smoke        # Run Agent smoke scenarios against a running server
npm run trace:otlp   # Convert recorded traces to OpenTelemetry OTLP/JSON
npm run stop         # Stop frontend and backend processes
npm run chrome:mcp   # Start the Chrome DevTools MCP SSE bridge
```

For smoke tests, start sagent first, then run `npm run smoke` in another terminal. Reports are written to `data/smoke-reports/`, and failed cases point to their trace files under `data/projects/default/traces/`.

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
