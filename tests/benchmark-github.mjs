/**
 * Live A/B token benchmark against the real GitHub MCP server.
 *
 *   node tests/benchmark-github.mjs                 # public repo, no token needed (60 req/h limit)
 *   GITHUB_PERSONAL_ACCESS_TOKEN=... GITHUB_REPO=owner/name node tests/benchmark-github.mjs
 *
 * Both modes run the same downstream server through the same gateway code:
 *   baseline = --passthrough (every raw schema in tools/list, raw results)  == standard MCP
 *   gateway  = meta-tools + catalog, distilled results, cache
 * Tokens are counted with the o200k tokenizer (js-tiktoken) and with the gateway's own
 * offline estimator. Results are written to .zak-gateway/benchmark-github.json.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEncoding } from "js-tiktoken";
import { GatewayServer, GatewayConfigSchema, estimateTokens } from "../dist/index.js";

const enc = getEncoding("o200k_base");
const tok = text => enc.encode(text).length;
const [owner, repo] = (process.env.GITHUB_REPO || "modelcontextprotocol/servers").split("/");
const configPath = path.resolve(process.argv[2] || "config/servers.json");
const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const githubConfig = fileConfig.mcpServers?.github ?? { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };

async function start(passthrough) {
  const config = {
    ...GatewayConfigSchema.parse({
      gateway: { ...fileConfig.gateway, stats: { enabled: false } },
      mcpServers: { github: githubConfig }
    }),
    configDir: os.tmpdir()
  };
  const gw = new GatewayServer(config, { passthrough });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gw.connect(b);
  const client = new Client({ name: "bench", version: "1" }, { capabilities: {} });
  await client.connect(a);
  return { gw, client };
}

const text = r => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");

// Realistic read-only agent steps. `search` is the query a model would send first in gateway mode.
const tasks = [
  { id: "recent-commits", search: "list recent commits", tool: "list_commits", args: { owner, repo, perPage: 10 } },
  { id: "commits-projected", search: null, tool: "list_commits", args: { owner, repo, perPage: 30 }, project: ["sha", "commit.message"] },
  { id: "open-issues", search: "list open issues", tool: "list_issues", args: { owner, repo, state: "open", per_page: 20 } },
  { id: "closed-prs", search: "list pull requests", tool: "list_pull_requests", args: { owner, repo, state: "closed", per_page: 10 } },
  { id: "search-repos", search: "search repositories", tool: "search_repositories", args: { query: "model context protocol server", perPage: 10 } },
  { id: "readme", search: "read a file from the repository", tool: "get_file_contents", args: { owner, repo, path: "README.md" } },
  { id: "repeat-commits", search: null, tool: "list_commits", args: { owner, repo, perPage: 10 } }
];

async function main() {
  console.log(`Benchmark repo: ${owner}/${repo}   token: ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN ? "yes" : "no (public, rate-limited)"}\n`);
  const base = await start(true);
  const gate = await start(false);

  const baseList = JSON.stringify((await base.client.listTools()).tools);
  const gateList = JSON.stringify((await gate.client.listTools()).tools) + (gate.client.getInstructions() ?? "");
  const defs = { baseline: tok(baseList), gateway: tok(gateList), baselineEst: estimateTokens(baseList), gatewayEst: estimateTokens(gateList) };

  const rows = [];
  for (const t of tasks) {
    const b = await base.client.callTool({ name: `github__${t.tool}`, arguments: t.args });
    let searchTokens = 0;
    if (t.search) {
      const s = await gate.client.callTool({ name: "mcp_search_tools", arguments: { query: t.search, limit: 3 } });
      searchTokens = tok(text(s)) + tok(JSON.stringify({ query: t.search, limit: 3 }));
      if (!text(s).includes(`github__${t.tool}(`)) console.warn(`  ! search "${t.search}" did not return github__${t.tool}`);
    }
    const g = await gate.client.callTool({
      name: "mcp_call_tool",
      arguments: { tool_name: `github__${t.tool}`, arguments: t.args, ...(t.project ? { project_fields: t.project } : {}) }
    });
    const row = {
      id: t.id,
      tool: t.tool,
      baseline: tok(text(b)),
      gateway: tok(text(g)),
      searchTokens,
      baselineError: !!b.isError,
      gatewayError: !!g.isError,
      gatewayPreview: text(g).slice(0, 400)
    };
    rows.push(row);
    console.log(`${t.id.padEnd(18)} raw ${String(row.baseline).padStart(6)}  gateway ${String(row.gateway).padStart(5)}  (+search ${searchTokens})${b.isError || g.isError ? "  ERROR: " + text(b.isError ? b : g).slice(0, 120) : ""}`);
  }
  const summary = gate.gw.stats.summary();

  // Agent-loop simulation: every model request re-sends tool definitions + all history.
  // Baseline: 1 request per step. Gateway: +1 request for each search.
  function loop(defsTokens, steps) {
    let history = 0, uncached = 0, cached = 0, prevPrompt = 0, requests = 0;
    const request = added => {
      const prompt = defsTokens + history;
      uncached += prompt;
      // Prompt caching (Anthropic-style): previously seen prefix at 10%, new tokens at 125% (cache write).
      cached += Math.min(prevPrompt, prompt) * 0.1 + Math.max(0, prompt - prevPrompt) * 1.25;
      prevPrompt = prompt;
      requests++;
      history += added;
    };
    for (const s of steps) {
      if (s.search) request(s.search); // model asks search, gets signatures
      request(s.result); // model calls tool, gets result
    }
    request(0); // final answer
    return { requests, uncached: Math.round(uncached), cached: Math.round(cached) };
  }
  const CALL_OVERHEAD = 40; // tokens the model spends writing each tool call (both modes)
  const baseLoop = loop(defs.baseline, rows.map(r => ({ result: r.baseline + CALL_OVERHEAD })));
  const gateLoop = loop(defs.gateway, rows.map(r => ({ search: r.searchTokens ? r.searchTokens + CALL_OVERHEAD : 0, result: r.gateway + CALL_OVERHEAD })));

  const totals = {
    resultsBaseline: rows.reduce((s, r) => s + r.baseline, 0),
    resultsGateway: rows.reduce((s, r) => s + r.gateway, 0),
    searchOverhead: rows.reduce((s, r) => s + r.searchTokens, 0)
  };
  const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;
  console.log(`\nTool definitions per request: baseline ${defs.baseline}  gateway ${defs.gateway}  saved ${pct(defs.baseline, defs.gateway)}  (estimator: ${defs.baselineEst} vs ${defs.gatewayEst})`);
  console.log(`Tool results total:           baseline ${totals.resultsBaseline}  gateway ${totals.resultsGateway} (+${totals.searchOverhead} search)  saved ${pct(totals.resultsBaseline, totals.resultsGateway + totals.searchOverhead)}`);
  console.log(`Agent loop input tokens:      baseline ${baseLoop.uncached} (${baseLoop.requests} req)  gateway ${gateLoop.uncached} (${gateLoop.requests} req)  saved ${pct(baseLoop.uncached, gateLoop.uncached)}`);
  console.log(`  with prompt caching:        baseline ${baseLoop.cached}  gateway ${gateLoop.cached}  saved ${pct(baseLoop.cached, gateLoop.cached)}`);
  console.log(`Gateway cache hits: ${summary.cacheHits}`);

  const out = { date: new Date().toISOString(), repo: `${owner}/${repo}`, tokenizer: "o200k_base", defs, rows, totals, baseLoop, gateLoop, cacheHits: summary.cacheHits };
  fs.mkdirSync(".zak-gateway", { recursive: true });
  fs.writeFileSync(".zak-gateway/benchmark-github.json", JSON.stringify(out, null, 2));
  console.log("\nSaved .zak-gateway/benchmark-github.json");

  await base.gw.close();
  await gate.gw.close();
  await base.client.close();
  await gate.client.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
