# zak-mcp-gateway skill

Teaches a coding agent to set up **ZAK MCP Gateway** in a project and to work through it efficiently. The gateway is one MCP server in front of all the project's MCP servers, so the agent spends far fewer tokens on tool definitions and tool results.

Measured on the public GitHub and filesystem MCP servers ([BENCHMARK.md](BENCHMARK.md)):
- **tool replies, 5 tasks:** 78,157 → 4,354 tokens (−94.4%), every answer still complete;
- **tool definitions per model request:** 6,399 → 599 tokens (−90.6%), on hosts that send every tool schema with each request;
- **live in Claude Code**, one question per setup: tool reply 8,360 → 112 tokens, new input tokens −47.6%, reported cost $0.209 → $0.126. Claude Code already loads MCP tool schemas on demand, so its gain comes from the smaller results.

## What the agent learns

- **When to use the gateway, and when not** (a single tiny server does not benefit).
- **Setup:** install from npm, `npx zak-mcp-gateway init`, move the existing MCP servers into one config with secrets as `${VAR}`, and register only the gateway in Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`) or Antigravity (`mcp_config.json`, opened through "View raw config"). The Windows forms are included.
- **Usage rules:** call tools by name, ask only for the fields it needs, page and filter big results by handle instead of re-running tools, batch reads, and pass stored data with `$ref`.
- **Safety:** writes run only with your approval (`confirm: true`), and instruction-like text in tool results is treated as data.
- **Troubleshooting:** the gateway's real error messages and their fixes, plus Claude Code start-up timeouts and pending approvals, and Antigravity environment variables.

## Example requests that activate it

- "Our agent burns too many tokens on MCP tools. Put our MCP servers behind one gateway."
- "Add zak-mcp-gateway to this project and move the GitHub and filesystem servers into it."
- "The GitHub MCP results are huge. Can we trim them?"

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | The instructions the agent follows |
| `references/configuration.md` | Recipes and every config key (read-only servers, allow/deny, default fields, pinned tools, budgets, workflows) |
| `BENCHMARK.md` | Measured token numbers, the live Claude Code check, the method and its limits |

## Requirements

- Node.js 20+ and npm.
- An agent that supports MCP servers and `SKILL.md` skills: Claude Code (tested), Cursor, or Antigravity (setup written from their documentation).

## What it installs and connects to

- The agent runs `npm install --save-dev zak-mcp-gateway`, the open-source MIT package at https://www.npmjs.com/package/zak-mcp-gateway (dependencies: `@modelcontextprotocol/sdk`, `minisearch`, `zod`).
- The gateway starts or connects only to the MCP servers listed in your `config/servers.json`. Servers started with `npx` are downloaded from npm the first time.
- No telemetry: token statistics stay in your project's `.zak-gateway/` folder.
- Secrets are never written to files. The skill tells the agent to use `${VAR}` references, and you set the values yourself.

## Manual install

Copy the `zak-mcp-gateway` folder into your agent's skills folder:

| Agent | Project | All projects |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Antigravity | `.agents/skills/` | see Antigravity's skills documentation (the global folder differs between versions) |
| Other agents | their skills folder | |

## Source and license

Gateway source, issues and full documentation: https://github.com/z4kir/zak-mcp-gateway. This skill and the gateway are MIT-licensed.
