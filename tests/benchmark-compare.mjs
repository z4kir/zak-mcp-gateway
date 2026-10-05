/**
 * Live 3-way token benchmark against the real GitHub MCP server:
 *   A. no gateway (standard MCP: every raw schema, raw results)
 *   B. gateway v0.2 (a previous build, given by --v02 <dist dir>)
 *   C. gateway v0.3 (this build)
 *
 *   node tests/benchmark-compare.mjs --v02 <path-to-v0.2>/dist
 *
 * Same repo, same calls, same tokenizer (o200k). Agent behaviour per setup:
 *   A: one model request per tool call
 *   B: one search (3 hits) before each new tool, as v0.2's instructions suggest
 *   C: reported as a range: worst case = search first (compact results), best case = call
 *      by name from the catalog without searching (v0.3's instructions). Plus an aggregation
 *      task where v0.3 counts with group_by/count instead of reading rows.
 * Each model request re-sends tool definitions + all earlier history (no trimming).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("o200k_base");
const tok = t => enc.encode(t).length;
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const v02Dist = arg("--v02");
if (!v02Dist || !fs.existsSync(path.join(v02Dist, "index.js"))) {
  console.error("Usage: node tests/benchmark-compare.mjs --v02 <v0.2 dist dir>");
  process.exit(1);
}
const [owner, repo] = (process.env.GITHUB_REPO || "modelcontextprotocol/servers").split("/");
const fileConfig = JSON.parse(fs.readFileSync("config/servers.json", "utf-8"));
const github = fileConfig.mcpServers.github;

async function load(dist) {
  const mod = await import(pathToFileURL(path.join(path.resolve(dist), "index.js")).href);
  return mod.GatewayServer ? mod : mod.default;
}

async function start(api, passthrough) {
  const config = {
    ...api.GatewayConfigSchema.parse({ gateway: { ...fileConfig.gateway, stats: { enabled: false } }, mcpServers: { github } }),
    configDir: os.tmpdir()
  };
  const gw = new api.GatewayServer(config, { passthrough });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gw.connect(b);
  const client = new Client({ name: "bench", version: "1" }, { capabilities: {} });
  await client.connect(a);
  const defsText = JSON.stringify((await client.listTools()).tools) + (client.getInstructions() ?? "");
  return { gw, client, defs: tok(defsText) };
}

const text = r => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
const CALL = 40; // tokens the model writes per tool call (same everywhere)

const tasks = [
  { id: "recent-commits", search: "list recent commits", tool: "list_commits", args: { owner, repo, perPage: 10 } },
  { id: "commits-projected", tool: "list_commits", args: { owner, repo, perPage: 30 }, project: ["sha", "commit.message"] },
  { id: "open-issues", search: "list open issues", tool: "list_issues", args: { owner, repo, state: "open", per_page: 20 } },
  { id: "closed-prs", search: "list pull requests", tool: "list_pull_requests", args: { owner, repo, state: "closed", per_page: 10 } },
  { id: "search-repos", search: "search repositories", tool: "search_repositories", args: { query: "model context protocol server", perPage: 10 } },
  { id: "readme", search: "read a file from the repository", tool: "get_file_contents", args: { owner, repo, path: "README.md" } },
  { id: "repeat-commits", tool: "list_commits", args: { owner, repo, perPage: 10 } },
  // "How many of the 30 newest open issues are pull requests?"
  { id: "count-prs", tool: "list_issues", args: { owner, repo, state: "open", per_page: 30 }, aggregate: true }
];

/** Agent-loop input tokens: every request = defs + all history so far. */
function loop(defs, steps) {
  let history = 0, total = 0, requests = 0;
  for (const added of steps) {
    total += defs + history;
    requests++;
    history += added;
  }
  total += defs + history; // final answer
  requests++;
  return { total, requests };
}

async function main() {
  console.log(`Repo ${owner}/${repo} · tokenizer o200k · ${new Date().toISOString()}\n`);
  const v02 = await load(v02Dist);
  const v03 = await load("dist");
  const A = await start(v03, true);
  const B = await start(v02, false);
  const C = await start(v03, false);
  const rows = [];

  for (const t of tasks) {
    const name = `github__${t.tool}`;
    const a = await A.client.callTool({ name, arguments: t.args });

    const callArgs = { tool_name: name, arguments: t.args, ...(t.project ? { project_fields: t.project } : {}) };
    const searchArgs = { query: t.search ?? "", limit: 3 };
    const bSearch = t.search ? tok(text(await B.client.callTool({ name: "mcp_search_tools", arguments: searchArgs }))) + CALL : 0;
    const b = await B.client.callTool({ name: "mcp_call_tool", arguments: callArgs });
    const cSearch = t.search ? tok(text(await C.client.callTool({ name: "mcp_search_tools", arguments: searchArgs }))) + CALL : 0;
    const c = await C.client.callTool({ name: "mcp_call_tool", arguments: callArgs });

    const row = { id: t.id, raw: tok(text(a)), v02: tok(text(b)), v03: tok(text(c)), v02Search: bSearch, v03Search: cSearch, extra02: [], extra03: [] };

    if (t.aggregate) {
      // v0.2: page the stored rows to count (no aggregation available); v0.3: one count call.
      const h2 = text(b).match(/\[(r\d+):/)?.[1];
      if (h2) row.extra02.push(tok(text(await B.client.callTool({ name: "mcp_get_result", arguments: { handle: h2, fields: ["number", "pull_request.html_url"], limit: 30 } }))) + CALL);
      const h3 = text(c).match(/\[(r\d+):/)?.[1];
      if (h3) row.extra03.push(tok(text(await C.client.callTool({ name: "mcp_get_result", arguments: { handle: h3, grep: "/pull/", count: true } }))) + CALL);
    }
    if (a.isError || b.isError || c.isError) row.error = text(a.isError ? a : b.isError ? b : c).slice(0, 160);
    rows.push(row);
    console.log(`${t.id.padEnd(18)} raw ${String(row.raw).padStart(6)} | v0.2 ${String(row.v02).padStart(5)} (+search ${bSearch}${row.extra02.length ? ` +pages ${row.extra02[0]}` : ""}) | v0.3 ${String(row.v03).padStart(5)} (+search ${cSearch}${row.extra03.length ? ` +count ${row.extra03[0]}` : ""})${row.error ? "  ERROR " + row.error : ""}`);
  }

  const stepsA = rows.map(r => r.raw + CALL);
  const stepsB = rows.flatMap(r => [...(r.v02Search ? [r.v02Search] : []), r.v02 + CALL, ...r.extra02]);
  const stepsCworst = rows.flatMap(r => [...(r.v03Search ? [r.v03Search] : []), r.v03 + CALL, ...r.extra03]);
  const stepsCbest = rows.flatMap(r => [r.v03 + CALL, ...r.extra03]);
  const out = {
    date: new Date().toISOString(),
    repo: `${owner}/${repo}`,
    defs: { none: A.defs, v02: B.defs, v03: C.defs },
    results: {
      none: rows.reduce((s, r) => s + r.raw, 0),
      v02: rows.reduce((s, r) => s + r.v02 + r.v02Search + r.extra02.reduce((x, y) => x + y, 0), 0),
      v03worst: rows.reduce((s, r) => s + r.v03 + r.v03Search + r.extra03.reduce((x, y) => x + y, 0), 0),
      v03best: rows.reduce((s, r) => s + r.v03 + r.extra03.reduce((x, y) => x + y, 0), 0)
    },
    loop: {
      none: loop(A.defs, stepsA),
      v02: loop(B.defs, stepsB),
      v03worst: loop(C.defs, stepsCworst),
      v03best: loop(C.defs, stepsCbest)
    },
    rows
  };
  const pct = (base, x) => `${(((base - x) / base) * 100).toFixed(1)}%`;
  console.log(`\nTool definitions / request: none ${out.defs.none} · v0.2 ${out.defs.v02} · v0.3 ${out.defs.v03}`);
  console.log(`Tool output incl. search:   none ${out.results.none} · v0.2 ${out.results.v02} · v0.3 ${out.results.v03best}–${out.results.v03worst}`);
  for (const k of ["none", "v02", "v03worst", "v03best"]) {
    const l = out.loop[k];
    console.log(`Agent loop ${k.padEnd(9)} ${String(l.total).padStart(8)} input tokens, ${l.requests} requests${k === "none" ? "" : `  (saves ${pct(out.loop.none.total, l.total)} vs none)`}`);
  }
  fs.mkdirSync(".zak-gateway", { recursive: true });
  fs.writeFileSync(".zak-gateway/benchmark-compare.json", JSON.stringify(out, null, 2));
  for (const s of [A, B, C]) {
    await s.client.close();
    await s.gw.close();
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
