# Agensi listing draft: zak-mcp-gateway (free)

Upload: `skills/dist/zak-mcp-gateway.zip` (build it with `npm run pack:skill`).

## Title

ZAK MCP Gateway: one MCP server for all your MCP servers

## Tagline

Put every MCP server behind one gateway and cut the tokens your agent spends on MCP tools: 94% fewer reply tokens in our public-server benchmark.

## Price

Free

## Category

Developer Tools (or the closest MCP / productivity category offered)

## Tags

mcp, model-context-protocol, mcp-gateway, token-optimization, cost-reduction, claude-code, cursor, antigravity, github

## Compatible agents

Claude Code and Google Antigravity (both tested end to end), Cursor (setup written from its documentation), and other agents that support SKILL.md skills and MCP servers.

## Version

1.0.0 (for zak-mcp-gateway 0.4.2 or newer)

## Description

Every MCP server you connect sends its full tool schemas with every model request, and its tools return long raw JSON that stays in the conversation. This skill teaches your agent to fix both with **ZAK MCP Gateway**, an open-source (MIT) npm package that sits between the agent and your MCP servers.

**What your agent learns**
- **When it helps, and when it doesn't.** It helps with two or more servers, large servers such as GitHub, and long JSON results. It doesn't help with a single tiny server.
- **Setup in a few commands:** `npm install --save-dev zak-mcp-gateway`, `npx zak-mcp-gateway init`, move your servers into one config with secrets as `${VAR}`, verify them with `npx zak-mcp-gateway check`, and register only the gateway in Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`) or Antigravity (`mcp_config.json`). The Windows forms are included.
- **Usage rules that save tokens:** call tools by name, request only the fields you need, page and filter big results by handle instead of re-running tools, batch reads, and pass stored data between calls with `$ref`.
- **Safety:** write tools run only after you approve them, servers can be made read-only or limited with allow/deny lists, and instruction-like text in tool results is flagged as data.
- **Troubleshooting:** the gateway's real error messages, each with its fix.

**Measured on public MCP servers** (GitHub + filesystem, 40 tools, 5 read-only tasks, o200k tokenizer, gateway 0.4.2; full method and limits in BENCHMARK.md):

| | Without gateway | With gateway |
|---|---:|---:|
| Tool definitions per model request | 6,399 tokens | 599 tokens (−90.6%) |
| Tool replies, 5 tasks | 79,507 tokens | 4,369 tokens (−94.5%) |
| Whole agent run (replayed) | 342,352 input tokens | 20,104 input tokens (−94.1%) |

Every gateway reply still contained the answer to its task. The tool-definition saving applies to hosts that send every schema with each request, such as Antigravity.

**Live in Claude Code 2.1** (one question, run once each way): the same correct answer, the tool reply went from 8,360 to 112 tokens, new input tokens fell 47.6%, and the cost Claude Code reported went from $0.209 to $0.126. Claude Code already loads MCP tool schemas on demand, so there the gain comes from the smaller results.

**Robust start-up:** the gateway waits at most 15 seconds for the servers behind it before answering the agent, and slower servers keep starting in the background. A server that needed 40 seconds made the previous version time out in Claude Code; 0.4.2 connects and answers.

**What's in the package:** `SKILL.md` (instructions), `references/configuration.md` (recipes and every config key), `BENCHMARK.md` (numbers, method, limits) and `README.md`. Text files only.

**What it installs and connects to:** the `zak-mcp-gateway` package from npm (dependencies: `@modelcontextprotocol/sdk`, `minisearch`, `zod`), plus the MCP servers you list in your own config. No telemetry: token statistics stay in your project's `.zak-gateway/` folder. Secrets are never written to files.

**Requirements:** Node.js 20+ and npm.

Tested on Windows with Node 22 in two ways. The setup steps were followed literally from an empty folder, with the gateway driven by an MCP client. Claude Code 2.1 was also run end to end. It loaded the skill, did the setup in an empty folder (handing the final `.mcp.json` to the user, because Claude Code protects that file), answered through the gateway, and ran a write through its confirmation step. In Google Antigravity, the agent found the skill in the workspace, set the gateway up, and answered a GitHub question through it once the gateway was registered.

**Source, issues and docs:** https://github.com/z4kir/zak-mcp-gateway · npm: https://www.npmjs.com/package/zak-mcp-gateway

## Changelog

1.0.0: first release.
