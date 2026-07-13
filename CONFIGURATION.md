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
    },
    "jetbrains": {
      "enabled": false,
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@jetbrains/mcp-proxy"]
      },
      "projectPath": "."
    }
  }
}
```

Values not present in the file use the canonical defaults defined by the backend schema.

The schema lives in `agent/core/config-schema.ts`; loading, migration, source tracking and atomic persistence are handled by `agent/core/config-store.ts`.

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
  < legacy Agent environment defaults
  < data/config.json
  < per-run request values
```

The `execution` section is startup-only. Explicit startup environment values override stored execution preferences so commands and deployment manifests remain deterministic. In particular, `npm run sandbox` sets `AGENT_SANDBOXED_WORKERS=true` and always selects the worker runner for that server process.

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
    "args": ["-y", "@jetbrains/mcp-proxy"],
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

The Settings UI can save and test the built-in `chrome` and `jetbrains` connections, plus arbitrary generic MCP servers. Chrome currently uses SSE; JetBrains supports SSE and stdio; generic servers support stdio, SSE, and Streamable HTTP.

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
- Legacy Agent tuning environment variables remain fallback defaults during migration.
- Legacy `CHROME_MCP_*` and `IDE_MCP_*` values appear in the Settings UI and are converted after saving.
- `MODELS`, `AGENT_MULTI_MODELS`, and `AGENT_HEADLESS` are ignored.

The server logs migration and deprecation warnings without printing secrets.

## Docker

Docker should continue to receive secrets and deployment values through `.env`:

```bash
docker compose up --build
```

Mount the data directory to preserve `config.json`, project memory and traces. Container startup may set worker sandbox variables as compatibility defaults when no structured execution configuration exists.
