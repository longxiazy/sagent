# Configuration

Sagent separates deployment secrets from user-facing Agent configuration:

- `.env`: provider keys, server binding, authentication and local binary paths.
- `data/config.json`: Agent profile, limits, context policy, tools and MCP servers.
- Settings UI: edits `data/config.json` and applies hot-reloadable values to the next run.

`data/config.json` is local runtime state and should not be committed.

## Minimal setup

```bash
cp .env.example .env
```

Configure at least one provider:

```bash
NVIDIA_API_KEY=nvapi-...
# or
GEMINI_API_KEY=...
```

Then start Sagent:

```bash
npm run sandbox
```

## Environment variables

### Providers and secrets

| Variable | Purpose | Default |
| --- | --- | --- |
| `NVIDIA_API_KEY` | NVIDIA or OpenAI-compatible provider key | — |
| `NVIDIA_BASE_URL` | OpenAI-compatible API base URL | `https://integrate.api.nvidia.com/v1` |
| `GEMINI_API_KEY` | Google Gemini API key | — |

### Server deployment

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` | Bind address | `127.0.0.1` |
| `PORT` | Backend port | `3001` |
| `SAGENT_API_TOKEN` | Bearer / `X-Sagent-Token` authentication token | empty on loopback |
| `SAGENT_CORS_ORIGINS` | Additional allowed browser origins | empty |
| `MEMORY_DIR` | Runtime data and configuration directory | `data` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` | `info` |

Non-loopback `HOST` values require a token of at least 16 characters.

### Local runtime overrides

| Variable | Purpose |
| --- | --- |
| `AGENT_BROWSER_PATH` | Browser executable override |
| `AGENT_MACOS_HELPER_PATH` | macOS helper executable override |
| `SAGENT_SHELL` | Shell used by confirmed terminal actions |
| `BUN_BIN` | Bun executable used by workers |
| `SANDBOX_EXEC` | macOS sandbox executable override |
| `VISION_MODEL` | Fallback model for `image_analyze`. The vision tool first picks any run-selected model that accepts image input; this variable only applies when none does and no project/global `tools.vision.model` is set. Unset = fall back to the run's main model |
| `DISTILL_MODEL` | Cheap OpenAI-compatible model that distills `http_fetch` page text before it enters agent history; cuts prompt-token growth on multi-source browsing. Unset = fall back to the run's main model |

Both tool models resolve as **project override → global `tools.<tool>.model` → environment variable → current main model**; there is no built-in default model. The Settings › Models panel shows this chain with the layer currently in effect.

## Structured configuration

The Settings UI creates a versioned document at `data/config.json`:

```json
{
  "version": 1,
  "profile": "balanced",
  "agent": {
    "maxSteps": 8,
    "modelTimeoutSec": 90,
    "maxOutputTokens": 4096,
    "maxHistorySteps": 6,
    "maxResultChars": 4000,
    "memoryMaxEntries": 20,
    "autoModelRouting": false
  },
  "execution": {
    "resume": true,
    "sandboxedWorkers": true,
    "workerSandbox": true
  },
  "tools": {
    "vision": { "model": "auto" },
    "screenshots": { "redaction": "pixelate" }
  },
  "models": {
    "nonAgentKeywords": ["embed", "rerank", "-vision", "-vl-", "guard"],
    "agentCompatible": {
      "meta/llama-3.2-90b-vision-instruct": true
    }
  },
  "mcpServers": {
    "chrome": {
      "enabled": true,
      "transport": {
        "type": "sse",
        "url": "http://127.0.0.1:3099/sse"
      },
      "promptMode": "lazy",
      "toolTimeoutMs": 60000,
      "navigateTimeoutMs": 25000
    }
  }
}
```

Values not present in the file use the canonical defaults defined by the backend schema.

The schema lives in `agent/core/config-schema.ts`; loading, migration, source tracking and atomic persistence are handled by `agent/core/config-store.ts`.

### Model admission policy (`models`)

`/api/models` and `/v1/models` always return **every** model the providers report — nothing is dropped for being "noisy". The `models` block only decides which of them carry `agentCompatible: false`, and the client hides those from the **Agent model selector** alone. Chat, the OpenAI-compatible endpoints, and the Vision/Distill tool-model pickers all see the full list.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `nonAgentKeywords` | `string[]` | built-in table (see below) | Case-insensitive substring match against the model id. A hit marks the model `agentCompatible: false`. Setting `[]` disables keyword marking entirely. |
| `agentCompatible` | `Record<string, boolean>` | `{}` | Per-model verdict keyed by model id (case-insensitive). Highest precedence — use it to admit one model without rewriting the keyword table. |

Precedence, highest first:

1. `models.agentCompatible[id]`
2. `agentCompatible` from the provider catalog (`config/model-catalog/*-overrides.json`)
3. `models.nonAgentKeywords`
4. Otherwise unmarked, i.e. usable everywhere

The built-in keyword table covers embedding/rerank, vision/OCR, code-completion, guardrail, and image/video/speech generation model families; the authoritative list is `DEFAULT_NON_AGENT_KEYWORDS` in `agent/core/config-schema.ts`. Providing `nonAgentKeywords` **replaces** it rather than extending it.

To use a vision model for agent decisions:

```json
{
  "models": {
    "agentCompatible": { "meta/llama-3.2-11b-vision-instruct": true }
  }
}
```

The one remaining hard drop is capability-based, not taste-based: Gemini models that do not declare `generateContent` are omitted, because calling them would always fail.

Edit this from **Settings → Models**, which writes through `PUT /api/config/models`:

```json
{ "nonAgentKeywords": ["embed", "guard"], "agentCompatible": { "meta/llama-3.2-11b-vision-instruct": true } }
```

Either field may be `null` to drop that override and fall back to the built-in default; omitting a field leaves it untouched. Saving re-tags the in-memory model list in place, so changes apply immediately — no restart. Hand-editing `data/config.json` does require a restart, since the file is only read at startup.

## Profiles

| Profile | Intended use |
| --- | --- |
| `fast` | Short tasks with a small context and output budget |
| `balanced` | Default daily usage |
| `deep` | Longer research and coding tasks with routing enabled |
| `safe` | Conservative single-model execution without desktop observation |
| `custom` | Set automatically after editing individual values |

Profiles are starting points. Editing a field switches the profile to `custom`.

## Configuration precedence

Agent behavior is resolved in this order:

```text
built-in schema defaults
  < data/config.json
  < per-run request values
```

Agent runtime tuning fields (`maxSteps`, `modelTimeoutSec`, `maxOutputTokens`, `staggerDelaySec`, `batchSize`, `observeDesktop`, `maxHistorySteps`, `maxResultChars`, `autoModelRouting`) are resolved only from the built-in schema defaults and `data/config.json` (editable via the Settings UI, hot-applied to the next run). They no longer read any `AGENT_*` environment variable.

The `execution` section is startup-only. `sandboxedWorkers` is resolved solely from `data/config.json` (default `true` — the worker runner is selected unless the stored config sets it to `false`); it does not read any environment variable. `workerSandbox` still honors the `AGENT_WORKER_SANDBOX` override.

Provider keys and server deployment variables remain environment-only.

## MCP servers

MCP servers use the same structure regardless of vendor.

SSE transport:

```json
{
  "enabled": true,
  "transport": {
    "type": "sse",
    "url": "http://127.0.0.1:3099/sse",
    "messagesUrl": "http://127.0.0.1:3099/messages"
  }
}
```

stdio transport:

```json
{
  "enabled": true,
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "cwd": "."
  }
}
```

Streamable HTTP transport uses the same URL shape with `"type": "http"`:

```json
{
  "enabled": true,
  "transport": {
    "type": "http",
    "url": "https://example.com/mcp"
  }
}
```

The Settings UI can save and test the built-in `chrome` connection plus arbitrary generic MCP servers. Chrome currently uses SSE; generic servers support stdio, SSE, and Streamable HTTP.

Codex CLI can be registered as a generic stdio MCP server and used as a coding expert inside an sagent workflow:

```json
{
  "mcpServers": {
    "codex": {
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "codex",
        "args": ["mcp-server"],
        "cwd": "."
      },
      "toolTimeoutMs": 600000
    }
  }
}
```

When at least one generic server is enabled, the Agent receives three adapter tools:

- `mcp_list_servers`
- `mcp_list_tools(serverName)`
- `mcp_call_tool(serverName, toolName, arguments)`

Listing server/tool metadata is read-only. Generic tool calls require the normal sagent approval flow because an arbitrary MCP tool may modify files or external state.

## Migration from legacy configuration

- Existing `data/runtime-config.json` is automatically migrated to `data/config.json`.
- Agent tuning `AGENT_*` environment variables are no longer read; set these values in `data/config.json` or the Settings UI.
- Legacy `CHROME_MCP_*` values appear in the Settings UI and are converted after saving.
- `MODELS`, `AGENT_MULTI_MODELS`, and `AGENT_HEADLESS` are ignored.

The server logs migration and deprecation warnings without printing secrets.

## Docker

Docker should continue to receive secrets and deployment values through `.env`:

```bash
docker compose up --build
```

Mount the data directory to preserve `config.json`, project memory and traces. Container startup may set worker sandbox variables as compatibility defaults when no structured execution configuration exists.
