# Architecture

This document describes the repository-wide architecture. For React-specific details, see [client/ARCHITECTURE.md](client/ARCHITECTURE.md). For the Agent runtime, see [agent/ARCHITECTURE.md](agent/ARCHITECTURE.md) (subsystem overview and end-to-end run flow) and [agent/core/ARCHITECTURE.md](agent/core/ARCHITECTURE.md) (module-level breakdown of `agent/core/`). Configuration formats and migration rules are documented in [CONFIGURATION.md](CONFIGURATION.md).

## System overview

```text
React/Vite client
  ├─ chat, projects, settings and approvals
  └─ fetch + SSE
          │
          ▼
Express API in server.ts
  ├─ authentication, CORS and origin guard
  ├─ model and OpenAI-compatible routes
  ├─ Agent run lifecycle and streaming
  └─ project/configuration APIs
          │
          ▼
Agent runtime
  ├─ provider registry and model metadata
  ├─ race/vote planner
  ├─ policy and approval boundary
  ├─ tools: files, terminal, browser, vision, macOS and MCP
  └─ direct runner or short-lived worker process
          │
          ▼
data directory
  ├─ config.json and other global files
  ├─ projects/<id> and projects/default (per-scope memory, uploads,
  │    traces and session-checkpoints)
  └─ local caches and smoke reports
```

## Startup flow

1. `server.ts` loads deployment variables from `.env`.
2. Provider clients are created and their model lists are fetched. Startup fails if no provider can supply a usable model list.
3. `configStore` loads `data/config.json`, migrates legacy `runtime-config.json` when present, and computes effective Agent settings.
4. The project, run, approval and persistence stores are initialized.
5. The server selects the direct runner or sandboxed worker runner. Explicit startup environment variables override stored `execution` values, so `npm run sandbox` always enables workers.
6. API routes and the production client bundle are mounted.

The server no longer resumes incomplete runs on restart; Step-level checkpoints were removed. Session-level health snapshots remain for in-run manual rollback only.

## Configuration architecture

Configuration is intentionally split by lifecycle:

| Source | Owns | Reload behavior |
| --- | --- | --- |
| `.env` | provider secrets, server binding, authentication, logging and executable overrides | process restart |
| `agent/core/config-schema.ts` | Agent field types, defaults, ranges and profiles | code release |
| `data/config.json` | Agent overrides, MCP servers, tools and execution preferences | Agent values apply to the next run |
| per-run API payload | selected models, strategy and task-specific options | current run |

`agent/core/config-store.ts` is the stateful boundary around the structured document. It validates and normalizes input, performs atomic persistence, exposes source metadata to Settings, and provides synchronous effective values to hot runtime paths.

Agent tuning resolves as:

```text
schema defaults < data/config.json < per-run values
```

Agent tuning fields no longer read `AGENT_*` environment variables — they come from the built-in schema defaults and `data/config.json` only. Startup-only execution flags are different: `workerSandbox` honors the `AGENT_WORKER_SANDBOX` env override, while `sandboxedWorkers` is resolved from stored config only (default `true`).

## Agent run lifecycle

The client starts a run through the Agent API and consumes an SSE stream. The backend reserves the single active-run slot, creates a run record, then invokes the selected runner.

Each step follows this loop:

```text
observe → build bounded prompt → ask one or more models → select decision
        → classify policy → request approval when needed → execute tool
        → persist trace + session snapshot → continue or finish
```

The planner supports:

- `race`: accept the first valid decision and cancel remaining model calls.
- `vote`: wait for model decisions and aggregate the best action.

Agent values such as step limits, timeouts, output budgets and context limits are read from `configStore` at run time. Startup choices such as direct versus worker execution are fixed for the server process.

## Runner boundary

By default (`execution.sandboxedWorkers` unset or `true` in `data/config.json`) each run executes in a short-lived worker; on macOS the worker can additionally be constrained by `sandbox.sb`. Set `execution.sandboxedWorkers` to `false` in `data/config.json` to run the Agent in the backend process instead. This is resolved only from stored config — there is no environment-variable override.

The backend remains responsible for shared run state, approvals and SSE delivery. Worker messages bridge tool requests, trace events, approval decisions and cancellation back to the main process.

## Tools and policy

Tools are registered by the Agent runtime and normalized into structured actions. Policy classification occurs before side effects. Read-only operations may proceed directly; terminal execution, file mutation, package installation and other sensitive actions require explicit approval.

Chrome and generic MCP integrations are configured under `mcpServers` in `data/config.json`. Their clients translate SSE, stdio or Streamable HTTP configuration into MCP `tools/list` and `tools/call` operations. Prompt details are loaded lazily so disabled integrations do not consume prompt context.

## Persistence and recovery

Project data is isolated below the configured data directory. The no-project ("global") scope stores its run data under `projects/default/`, at the same level as each real project's `projects/<id>/`. Traces are append-only run diagnostics; session-checkpoints hold per-step health snapshots used for in-run manual rollback (a cancelled run removes them). There is no restart recovery.

Writes that must survive shutdown are tracked through the persistence queue. Server shutdown first stops accepting work, cancels or drains active runs, flushes queued persistence and LLM logs, then exits.

## Frontend boundaries

The React client keeps browser-local chat presentation state while the backend owns Agent execution state. On refresh, the client queries the active run and reconnects to its SSE stream. When a mobile browser resumes after being backgrounded, it fetches the persisted trace to recover terminal events that may have been missed.

Settings reads schema, effective values and source metadata from `/api/config`. Agent/profile changes and MCP connections are persisted and tested through the config API.

## Extension points

- Add a provider under `agent/core/providers/` and register it in the provider registry.
- Add an Agent action/tool under `agent/tools/`, then update policy classification and tests.
- Add a structured configuration field to `config-schema.ts`; consumers should read it through `configStore` rather than reading tuning environment variables directly.
- Add an API route under `routes/` and keep `server.ts` focused on composition and process lifecycle.
