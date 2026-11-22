# zak-mcp-gateway configuration reference

The config file (`config/servers.json` by default, created by `npx zak-mcp-gateway init`) has two parts: `gateway` (how the gateway behaves) and `mcpServers` (the servers it fronts, in the usual MCP client shape). Every key is optional except one server entry per server. Relative paths resolve against the config file's folder.

## Recipes

### A live server next to a local copy (0.5.0)

```json
"mcpServers": {
  "app": { "command": "node", "args": ["server.js"] },
  "app-live": {
    "url": "https://api.example.com/mcp",
    "headers": { "Authorization": "Bearer ${APP_LIVE_KEY}" },
    "label": "LIVE, production data",
    "confirmWrites": true
  }
}
```

The `label` appears in the catalog, in search hits and in `mcp_status`, so the agent knows which server is production. `confirmWrites: true` makes this server's writes ask first, even if `safety.confirmWrites` is off for the local one. It also protects the server: a bare tool name like `update_record` never resolves to it, even when the local copy is down. Only `app-live__update_record` reaches it. Use `"readOnly": true` instead to block its writes completely.

### See and recover failed servers (0.5.0)

`mcp_status` lists every server with its state (`ok`, `starting`, `FAILED`, `DISCONNECTED`), tool count, label and last error. The instructions add a `Not connected: <server> (<reason>)` line when a server failed at start. A call to a failed or dropped server reconnects it first, at most every `status.retryAfterMs` (30 s). `mcp_status` with `{"reconnect": "<id>"}` or `"all"` retries now. The gateway also writes `status.json` next to the stats log, which `npx zak-mcp-gateway status --line` prints as one line (`MCP app ✓  app-live ✗`) for status bars.

### Make one server read-only

```json
"mcpServers": {
  "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"], "readOnly": true }
}
```

Every write tool on that server is blocked with `Server "postgres" is read-only; write tool ... is blocked.` Use `"gateway": { "safety": { "readOnly": true } }` to block writes on all servers.

### Hide tools (allow / deny)

```json
"gateway": { "safety": { "deny": ["github__delete_*", "github__merge_pull_request"] } }
```

Globs match `server__tool` names (`*` = any characters, case-insensitive). With a non-empty `allow` list, only matching tools are visible.

### Writes need confirmation (on by default)

`"gateway": { "safety": { "confirmWrites": true } }`. The agent must repeat a write call with `"confirm": true` after the user agrees. Tools are classed as reads or writes from the server's `readOnlyHint` annotation first, then from verbs in the tool name. Unknown verbs count as writes.

### Keep only useful fields by default

```json
"github": {
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "projections": { "list_commits": ["sha", "commit.message", "commit.author.name"] },
  "dropKeys": ["url", "permissions", "reactions"]
}
```

`projections` apply when the agent sends no `project_fields`. `dropKeys` (globs) remove noise keys for this server, on top of the gateway defaults (`*_url`, `node_id`, `gravatar_id`, `_links`; `html_url` is kept).

### Let the agent skip searches for the tools it uses most

```json
"gateway": { "discovery": { "pinnedSignatures": ["github__list_issues", "github__create_issue"] } }
```

Pinned tools' one-line signatures are always in the instructions, so the agent can call them without `mcp_search_tools`. Each costs a few tokens per request, so pin about 10-12 tools at most.

### A server whose results are already compact

```json
"my-server": { "command": "node", "args": ["server.js"], "results": { "inlineTokenLimit": 8000, "distill": "light" } }
```

`distill`: `full` (default), `light`, or `off` (pass the text through untouched).

### Cap the tokens a session can spend on results

`"gateway": { "stats": { "sessionTokenBudget": 50000 } }`. At 80% results get half the room; at 100% calls stop with `Session token budget exhausted`.

### Sandboxed code mode (off by default)

`"gateway": { "codeMode": { "enabled": true, "timeoutMs": 30000, "maxToolCalls": 25 } }` adds `mcp_run_code`. It runs in a separate locked-down process with no file system or network access. While `confirmWrites` is on (the default), write tools cannot be called inside it.

### Remote server

```json
"remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" } }
```

Streamable HTTP, with a fallback to SSE.

### Multi-step workflow as one tool

```json
"gateway": {
  "workflows": {
    "repo_overview": {
      "description": "Latest commits and open issues of a repo in one call. Not for details of one item.",
      "input": { "properties": { "owner": { "type": "string" }, "repo": { "type": "string" } }, "required": ["owner", "repo"] },
      "steps": [
        { "id": "commits", "tool": "github__list_commits", "arguments": { "owner": "${input.owner}", "repo": "${input.repo}", "perPage": 5 }, "fields": ["sha", "commit.message"] },
        { "id": "issues", "tool": "github__list_issues", "arguments": { "owner": "${input.owner}", "repo": "${input.repo}", "state": "open", "per_page": 5 }, "fields": ["number", "title"] }
      ],
      "output": { "commits": "${steps.commits}", "issues": "${steps.issues}" }
    }
  }
}
```

The agent calls `wf__repo_overview` once. Steps follow the normal safety rules, writes need one confirmation for the whole workflow, and the run stops at the first failing step. `npx zak-mcp-gateway report` suggests workflows from repeated call sequences.

## All keys

| Key | Meaning |
|---|---|
| `env` / `headers` / `args` | `${VAR}` and `${VAR:-default}` are read from the environment. Placeholders like `<YOUR_TOKEN>` are ignored; hard-coded tokens trigger a warning. |
| `command` / `url` | stdio server, or remote Streamable HTTP server (falls back to SSE) |
| `projections` | Default fields per tool, used when the agent sends no `project_fields` |
| `dropKeys` | Extra noise keys (glob) for this server |
| `readOnly` | Block every write tool on this server |
| `confirmWrites` | Write confirmation for this server only (overrides `safety.confirmWrites`); `true` also means its tools are reached only by full name |
| `label` | Short note shown with the server, e.g. `"LIVE, production data"` |
| `pinned` | Also expose this server's tools directly with full schemas (costs tokens on every request; use sparingly) |
| `results` (per server) | `inlineTokenLimit`, `maxStringChars`, `distill: full / light / off`, `writeReceipts` |
| `synonyms`, `defaultArgs`, `forwardInstructions` | Per-server search vocabulary, injected default arguments, forwarding of the server's own instructions |
| `access`, `writeIf`, `cache`, `cacheTtlSeconds`, `cacheGroup` | Per-tool read/write overrides, argument-based writes, per-server cache control and shared invalidation |
| `gateway.status` | `tool` (true: expose `mcp_status`), `file` (status.json path; default next to the stats log, `false` = none), `retryAfterMs` (30000) |
| `gateway.startupWaitMs` | Longest wait for the servers before answering the agent's handshake (15000; `0` = wait for all). Slower servers keep connecting, and calls to them wait for them. |
| `gateway.cache` | `enabled`, `exactMatchTtlSeconds` (300), `maxEntries` (1000): identical read calls are answered from memory |
| `gateway.discovery` | `maxSearchResults` (5), `minScore`, `catalog` (`names` / `groups` / `servers` / `off`), `fullSignatures`, `hotSignatures`, `pinnedSignatures`, `metaToolStyle` (`standard` / `slim`), `signatureStyle` (`full` / `oneline`), `alsoStyle` (`summary` / `name`) |
| `gateway.results` | `inlineTokenLimit` (1500), `previewRows` (10), `maxStringChars` (600), `maxStored` (50), `tsv`, `dropKeys`, `keepKeys`, `writeReceipts`, `dedupe` |
| `gateway.safety` | `readOnly`, `confirmWrites` (true), `allow`, `deny`, `warnOnInjection` (true) |
| `gateway.stats` | `enabled`, `logFile`, `sessionTokenBudget` (0 = off) |
| `gateway.codeMode` | `enabled` (false), `isolation` (`process`, or `vm` for trusted code only), `timeoutMs`, `maxToolCalls`, `memoryMb` |
| `gateway.knowledge` | `rules`, `rulesFile`, `skillsDir`: rules and skills served to every client (`mcp_get_skill`) |
| `gateway.clientFeatures` | `elicitation`, `sampling`: forward downstream user prompts and model requests to the agent's client (off by default) |
| `gateway.workflows` | Named multi-step jobs (see the recipe above) |

A complete example with every section ships in the package at `node_modules/zak-mcp-gateway/config/servers.example.json`.
