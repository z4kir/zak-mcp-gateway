# Benchmark: with and without zak-mcp-gateway

Five read-only tasks on two **public** MCP servers, run once directly and once through the gateway. Every number is a real token count of the actual payload, measured with the o200k tokenizer.

| | |
|---|---|
| Date | 14 Nov 2026 |
| Gateway | `zak-mcp-gateway` 0.4.1 from npm, set up by following [SKILL.md](SKILL.md) in an empty folder, with the default config from `init` |
| Servers | `@modelcontextprotocol/server-github` (26 tools, public repo `modelcontextprotocol/servers`, no token) and `@modelcontextprotocol/server-filesystem` (14 tools, the project's own copy of the public `zak-mcp-gateway` npm package) |
| Without gateway | An MCP client connected straight to both servers |
| With gateway | The same client started the `.mcp.json` entry from the skill and followed the skill's usage rules |
| Tokenizer | o200k_base (js-tiktoken) |

## Tool definitions sent with every model request

| | Tools | Tokens |
|---|---:|---:|
| Without gateway | 40 | 6,399 |
| With gateway (3 meta-tools + one-line catalog) | 3 | **599** |
| Saved | | **90.6%** |

An agent pays this cost again on every model request, whether or not it uses a tool. This applies to hosts that send every tool schema up front. Claude Code 2.1 already loads MCP tool schemas on demand through its tool search, so there the gateway saves mainly on results (see the live check below).

## Tool replies per task

| Task | Question | Call | Without gateway | With gateway | Saved | Gateway, no `project_fields` |
|---|---|---|---:|---:|---:|---:|
| recent-commits | What changed recently in modelcontextprotocol/servers? | `github__list_commits` (10) | 18,297 | **866** | 95.3% | 1,273 |
| open-issues | Which open issues are there, and who opened them? | `github__list_issues` (open, 30 per page) | 46,168 | **511** | 98.9% | 919 |
| search-repos | Find repositories about MCP gateways. | `github__search_repositories` (10) | 3,586 | **313** | 91.3% | 1,430 |
| package-files | Which files does the zak-mcp-gateway package ship? | `filesystem__directory_tree` | 1,888 | **942** | 50.1% | n/a |
| readme-install | How do I install zak-mcp-gateway, according to its README? | `filesystem__read_text_file` | 8,218 | **1,722** (1,445 preview + 277 for one `mcp_get_result` grep) | 79.0% | n/a |
| **Total** | | | **78,157** | **4,354** | **94.4%** | |

With the gateway, every reply still held the answer to its question: commit messages, issue numbers, titles and authors, repository names and descriptions, the file tree, and the README's install commands (found by `grep` on the stored result). The GitHub server's search results contain no star counts in either setup.

Finding each tool with `mcp_search_tools` first cost 44 to 225 tokens per search (705 in total). Each search found the right tool as its top hit.

## Whole agent run

A replay model: each model request re-sends the tool definitions plus all earlier history, the model writes about 40 tokens per tool call, and one final request writes the answer. No prompt caching and no history trimming in either setup.

| Setup | Model requests | Input tokens | Saved |
|---|---:|---:|---:|
| Without gateway | 6 | 337,903 | |
| Gateway, agent calls tools by name (skill rule 1) | 7 | **20,029** | **94.1%** |
| Gateway, agent searches before every tool | 12 | 35,560 | 89.5% |
| Gateway, searches and ignores `project_fields` (rule 2) | 12 | 49,596 | 85.3% * |

\* Without `project_fields`, big GitHub lists come back as a one-row preview plus a handle, so a real agent would usually need one more `mcp_get_result` call. That extra call is not counted in this row, so its saving is overstated. Following rule 2 avoids the problem.

## Live check in Claude Code

The same question asked once in each setup through Claude Code 2.1.325 (headless, default model, clean profile): "List the open issues in modelcontextprotocol/servers that were opened by github-actions[bot]. Show number and title only." The servers were the same two public ones: connected directly in one run, behind the gateway in the other.

| | Servers connected directly | Through the gateway |
|---|---:|---:|
| Answer | 3 issues, correct | the same 3 issues, correct |
| Model requests | 3 | 3 |
| Tool calls | `ToolSearch` + `github__search_issues` | `ToolSearch` + one `mcp_call_tool` (called by name, with `project_fields`) |
| Tool reply sent to the model | 8,360 tokens (raw) | **112 tokens** (−98.7%) |
| New input tokens (cache writes) | 22,655 | **11,866** (−47.6%) |
| All input tokens, incl. Claude Code's cached system prompt | 121,701 | 111,583 (−8.3%) |
| Cost reported by Claude Code | $0.209 | **$0.126** (−39.7%) |

One run per setup, so treat these as an example, not an average. Claude Code's own system prompt and tools make up most of each request, and prompt caching bills them at a small fraction, so the cost fell much more than the raw token total.

In the same session, Claude Code twice loaded the skill in an empty folder and did the whole setup: `init`, the config, `.gitignore` and a passing start check. Each time it handed the final `.mcp.json` to the user, because Claude Code protects that file. It also ran a write through the gateway's confirmation step. It also confirmed that the gateway needs about 13-17 seconds to answer when started with `cmd /c npx -y` and two servers behind it. That is within Claude Code's default 30-second limit for starting an MCP server.

## Honest limits

- The token counts are real, but the agent runs are a replay of the same calls. No language model was called, and a live model may make more or fewer calls.
- o200k is OpenAI's tokenizer. Claude and other models count somewhat differently, but both setups were measured the same way.
- Hosts send tool definitions in their own formats, and the JSON of the tool list was used as the shared measure. Prompt caching would lower the absolute cost of both setups.
- The gateway helps most with large servers and long JSON lists. On a small tree (`package-files`) it saved about half. For one tiny server, its own ~600 tokens of meta-tools can cost more than they save.
- The gateway added `[gateway warning: this result contains instruction-like text...]` to the README reply. That is the prompt-injection guard reacting to ordinary install instructions: a harmless false positive, kept so agents treat results as data.
- Public GitHub data changes over time, so a re-run will give slightly different numbers.

## Reproduce

1. In an empty folder, follow [SKILL.md](SKILL.md): `npm install --save-dev zak-mcp-gateway`, `npx zak-mcp-gateway init`, add a `filesystem` server rooted at that folder next to `github`, and write `.mcp.json`.
2. In a clone of https://github.com/z4kir/zak-mcp-gateway: `npm install`, then `node tests/benchmark-skill.mjs --project <that folder>`.

The script prints these tables' numbers and saves them to `.zak-gateway/benchmark-skill.json`.
