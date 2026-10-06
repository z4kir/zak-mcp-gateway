/**
 * Builds one release note per version: docs/src/versions/vX.html -> docs/versions/ZAK_Gateway_vX.pdf
 *
 *   node docs/src/versions/build-versions.mjs            (CHROME env var overrides the browser path)
 *
 * Add a new entry to VERSIONS for every release; earlier entries never change.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "versions");
const chrome = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const VERSIONS = [
  {
    version: "0.1",
    date: "2–3 Oct 2026",
    theme: "First scaffold",
    summary: "The first version: one MCP server in front of many, exposing two small meta-tools instead of every tool's schema.",
    analogy: "A concierge desk opens: instead of 40 service counters, one desk that knows where everything is.",
    added: [
      ["Two meta-tools", "mcp_search_tools finds a tool; mcp_call_tool runs it.", "–"],
      ["BM25 tool search", "MiniSearch over tool names and descriptions.", "discovery.maxSearchResults"],
      ["Short signatures", "JSON Schema → one TypeScript-style line.", "–"],
      ["Exact-match cache", "SHA-256 of tool + arguments; repeat reads answered from memory.", "cache.*"],
      ["Projection + null pruning", "Keep only requested fields; drop empty values.", "project_fields"],
      ["Docs", "Whitepaper, implementation roadmap, concept explainer.", "docs/"]
    ],
    fixed: [],
    measured: [["Measured results", "None yet: the early documents contained projections, not measurements."]],
    notes: ["Several bugs in this version were found and fixed in v0.2 (cache key collision, caching never on, double-encoded results, GitHub token placeholder)."]
  },
  {
    version: "0.2",
    date: "4 Oct 2026",
    theme: "Build-plan upgrade",
    summary: "Implemented the architecture and build plan: result handles, trimming of results, safety, stats, and an honest A/B harness.",
    analogy: "The concierge learns to hand you a one-page summary and keep the full file in the back office (a coat-check ticket).",
    added: [
      ["mcp_get_result + handles", "Big results stay in the gateway; page, grep, pick fields, or raw.", "results.*"],
      ["Noise removal + TSV tables", "Drop API links and IDs; lists become tables.", "results.dropKeys, tsv"],
      ["Tool index in instructions", "One line per server listing tool names.", "discovery.catalogInInstructions"],
      ["Argument + name repair", "per_page → perPage, github::x → github__x; errors return the signature.", "–"],
      ["Safety policy", "Read-only modes, allow/deny lists, writes need confirm: true, injection warning.", "safety.*"],
      ["Stats + report + budget", "JSONL savings log, npm run report, zak://stats, session token budget.", "stats.*"],
      ["Remote servers + ${VAR} secrets", "Streamable HTTP/SSE servers; secrets only from the environment.", "url, headers, env"],
      ["Passthrough baseline", "--passthrough = plain MCP through the same config, for fair A/B tests.", "CLI flag"],
      ["Agent UI A/B", "Same Gemini question through plain MCP and the gateway, real usage numbers.", "agent-ui/"]
    ],
    fixed: [
      ["Cache key collision", "Every call hashed to the same key"],
      ["Caching never on", "The read/write check was bypassed"],
      ["Double-encoded results", "Results were bigger than the raw reply"],
      ["Placeholder token overrode the env", "GitHub 401"],
      ["github:: vs github__ names; per_page ignored", "Tool not found; wrong page size"],
      ["Agent UI made-up savings number", "Replaced with real A/B usage"]
    ],
    measured: [
      ["Tool definitions per request (GitHub)", "3,600 → 439 tokens (−88%)"],
      ["7 tool results", "157,173 → 7,452 tokens (−95%)"],
      ["Whole 7-step agent task", "805,337 → 55,130 tokens (−93%)"],
      ["Live Gemini A/B, one GitHub question", "20,806 → 2,522 input tokens (−87.9%)"],
      ["Gateway in front of the company lean server", "Lost to lean alone (243k vs 98k light task): extra searches and re-paging"]
    ],
    notes: ["Lesson that shaped v0.3: small answers are not enough; extra turns re-send the whole conversation."]
  },
  {
    version: "0.3",
    date: "5 Oct 2026",
    theme: "Economy upgrade: fewer turns",
    summary: "All 14 ideas of the economy plan plus 6 extras: fewer and smaller turns, big data kept inside the gateway, and precision helpers for any client.",
    analogy: "One trip with a shopping list instead of one trip per item; parcels forwarded without being opened.",
    added: [
      ["Per-server result modes", "full / light / off, per-server limits; compact servers stop being re-paged.", "mcpServers.*.results"],
      ["Compact search", "Top hit as a full signature, the rest as name + summary.", "discovery.fullSignatures"],
      ["Catalog modes + hot signatures", "names / groups / servers / off; most-used tools listed up front.", "discovery.catalog, hotSignatures"],
      ["Forwarded server instructions, synonyms, default args", "Server guidance kept; domain words; page size or field selection injected.", "forwardInstructions, synonyms, defaultArgs"],
      ["Batch calls", "Several calls in one turn; writes previewed and confirmed once.", "mcp_call_tool calls"],
      ["Aggregation + path", "count / group_by / distinct / sort; one field in full.", "mcp_get_result"],
      ["Safe cache", "Per-tool access, writeIf, cache groups, TTL, fresh.", "access, writeIf, cacheGroup"],
      ["Write receipts, $ref + patch, dedupe", "Short write replies; stored data passed into the next call; repeats as pointers.", "results.writeReceipts, dedupe"],
      ["Rules + skills", "Rules in every session; skills listed and loaded on demand.", "knowledge.*"],
      ["Elicitation / sampling pass-through", "Downstream servers can ask the user or the model.", "clientFeatures.*"],
      ["Sandboxed code mode", "Separate process, no file access, memory cap, hard timeout.", "codeMode.*"],
      ["Agent UI helpers", "Focused tools, history trimming, answer verifier, skill preload.", "agent-ui/"]
    ],
    fixed: [
      ["Compact replies re-paged under one global limit", "Per-server limits and light mode"],
      ["Raw paging cut lines silently", "CLIPPED notice"],
      ["Server instructions dropped", "Forwarded, capped"],
      ["path meant per row (found live with Gemini)", "Falls back to a per-row field"],
      ["Verifier matched numbers inside longer IDs", "Whole-token matching"]
    ],
    measured: [
      ["GitHub, 8 tasks, agent-run input", "none 1,085,806 · v0.2 74,019 · v0.3 48,465–71,827"],
      ["Company lean server, light task (6 Oct)", "lean 98,493 → gateway 41,054 (−58%)"],
      ["Company lean server, heavy build task", "lean + batch 201,090 → gateway 102,628 (−49%), 24/24 database checks"],
      ["Remaining cost (lean test)", "8 searches = 46% of result tokens; tool list = most of the rest"]
    ],
    notes: ["The lean test pointed at the next lever: remove searches before writes and cut the fixed cost of every turn."]
  },
  {
    version: "0.4",
    date: "6 Oct 2026",
    theme: "Fewer turns, cheaper turns: 7 improvements",
    summary: "Targets what the lean test showed: searches before writes, the fixed cost of every turn, and multi-step build jobs. All options are off by default; defaults behave exactly like v0.3.",
    analogy: "\"The usual, please\": the restaurant already knows the steps of the order and runs them all; you get one confirmation.",
    added: [
      ["#1 Pinned signatures", "Configured tools' one-line signatures always in the instructions, so writes need no search.", "discovery.pinnedSignatures"],
      ["#2 Workflow tools", "A configured multi-step job the agent runs in one call (wf__name); values flow between steps; one confirmation; stops and reports at the first failure; output trimmed like normal replies.", "gateway.workflows"],
      ["Workflow suggestions", "npm run report finds repeated call sequences and prints a workflow skeleton to review.", "npm run report"],
      ["#3 Cheaper fixed cost per turn", "Slim meta-tools; tool-inventory sentences of server instructions not repeated; groups catalog.", "discovery.metaToolStyle, catalog"],
      ["#4 Leaner search replies", "Top hit on one line, the rest as names only.", "discovery.signatureStyle, alsoStyle"],
      ["#5 Search re-ranking", "Tools whose name words match beat descriptions that repeat a common word; count synonyms.", "built in"],
      ["Multi-table replies", "An object holding several lists renders as several small tables.", "built in"],
      ["#6 History trimming (host)", "Agent UI shortens old results to handle stubs; recommended for every agent host.", "agent-ui switch"],
      ["#7 Prompt caching (host)", "Keep the tool list fixed so the host's prompt cache bills it at ~10%; note: focused tools change it per question.", "host setting"]
    ],
    fixed: [
      ["Workflow output carried raw step data (found in the GitHub run: 28,384 tokens)", "Output uses trimmed views; 808 tokens"],
      ["Search: 'add a field to a table' ranked the column tool 3rd", "Name re-ranking puts it 1st"],
      ["Several lists in one reply rendered as JSON", "Rendered as table sections"]
    ],
    measured: [
      ["GitHub, 9 tasks, agent-run input", "none 1,822,172 · v0.3 75,586–101,171 · v0.4 tuned 58,715–80,603"],
      ["Realistic: v0.3 searching vs v0.4 with pinned signatures", "101,171 → 58,715 (−42%), 18 → 11 model requests"],
      ["Repo overview: 3 calls vs 1 workflow", "753 tokens over 3 turns → 808 tokens in 1 turn"],
      ["Search accuracy", "GitHub + filesystem: 32/32 top-3, 31/32 top-1 (unchanged); lean-style catalog: 5/5 top-1"]
    ],
    notes: [
      "Pinned signatures cost ~100 tokens per turn; they pay off only when they remove searches. Pin the 10–12 tools used most, not everything.",
      "Workflows sit next to the normal tools; give each a clear \"use for / not for\" description.",
      "Next: re-run the company lean benchmark with pinned write signatures and one build workflow, then a live-model run."
    ]
  }
];

const css = `
  :root { --ink:#1b1f24; --ink-2:#4a5360; --ink-3:#7a838f; --line:#dfe3e8; --soft:#f6f7f9; --teal:#0f8a7e; --amber:#9a6a00; --amber-soft:#fff6e0; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Inter, Roboto, system-ui, sans-serif; color: var(--ink); margin: 0; padding: 28px 36px; font-size: 10.5pt; line-height: 1.5; background: #fff; }
  h1 { font-size: 22pt; margin: 0; } h2 { font-size: 13pt; margin: 20px 0 6px; padding-bottom: 3px; border-bottom: 2px solid var(--line); }
  .meta { color: var(--ink-2); margin: 4px 0 12px; } .chip { display:inline-block; background: var(--teal); color:#fff; border-radius: 10px; padding: 1px 9px; font-size: 9pt; font-weight: 700; vertical-align: 5px; margin-left: 6px; }
  .summary { font-size: 11pt; } .analogy { border-left: 4px solid var(--amber); background: var(--amber-soft); border-radius: 0 8px 8px 0; padding: 9px 13px; margin: 10px 0; } .analogy b { color: var(--amber); }
  table { width: 100%; border-collapse: collapse; font-size: 9.4pt; margin: 6px 0; } th, td { border-bottom: 1px solid var(--line); padding: 5px 7px; text-align: left; vertical-align: top; } th { background: var(--soft); }
  code { font-family: Consolas, monospace; font-size: 8.8pt; background: #eef1f4; padding: 0 4px; border-radius: 3px; }
  ul { margin: 4px 0 4px 18px; padding: 0; } .muted { color: var(--ink-3); font-size: 9pt; }
  @page { size: A4; margin: 14mm; } @media print { body { padding: 0; } tr, .analogy { break-inside: avoid; } }`;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const codeish = s => esc(s).replace(/\b([a-z]+(?:[._][a-zA-Z0-9]+)+|mcp_[a-z_]+|wf__name|--passthrough|npm run report)\b/g, "<code>$1</code>");

function page(v) {
  const rows = (items, cols) => items.map(r => `<tr>${r.map((c, i) => `<td${i === 0 ? ' style="width:' + cols + '"' : ""}>${i === 0 ? `<b>${esc(c)}</b>` : codeish(c)}</td>`).join("")}</tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ZAK MCP Gateway v${v.version}</title><style>${css}</style></head><body>
<h1>ZAK MCP Gateway <span class="chip">v${v.version}</span></h1>
<div class="meta">${esc(v.date)} · ${esc(v.theme)}</div>
<p class="summary">${esc(v.summary)}</p>
<div class="analogy"><b>In one picture:</b> ${esc(v.analogy)}</div>
<h2>What's new</h2>
<table><tr><th>Feature</th><th>What it does (simply)</th><th style="width:24%">Where to switch it</th></tr>${rows(v.added, "26%")}</table>
${v.fixed.length ? `<h2>Fixed</h2><table><tr><th>Problem</th><th>Result</th></tr>${rows(v.fixed, "55%")}</table>` : ""}
<h2>Measured</h2>
<table><tr><th>What</th><th>Result</th></tr>${rows(v.measured, "45%")}</table>
<h2>Notes</h2><ul>${v.notes.map(n => `<li>${codeish(n)}</li>`).join("")}</ul>
<p class="muted">All versions: docs/versions · Full explanation: docs/ZAK_Gateway_How_It_Works.pdf</p>
</body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
for (const v of VERSIONS) {
  const html = path.join(here, `v${v.version}.html`);
  const pdf = path.join(outDir, `ZAK_Gateway_v${v.version}.pdf`);
  fs.writeFileSync(html, page(v));
  if (fs.existsSync(chrome)) {
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, html], { stdio: "ignore" });
    console.log(`v${v.version} -> ${path.relative(root, pdf)}`);
  } else {
    console.log(`v${v.version} -> ${path.relative(root, html)} (Chrome not found; set CHROME to also build the PDF)`);
  }
}
