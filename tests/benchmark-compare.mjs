/**
 * Live token benchmark against the real GitHub MCP server:
 *   none      no gateway (standard MCP: every raw schema, raw results)
 *   prev      an earlier gateway build (--prev <dist dir>, label from its package.json)
 *   current   this build with config/servers.json
 *   tuned     this build + the v0.4 options (pinned signatures, groups catalog, slim
 *             meta-tools, one-line search, a workflow for the overview task)
 *
 *   node tests/benchmark-compare.mjs --prev <older dist dir>
 *
 * Same repo, same calls, same tokenizer (o200k). Agent behaviour per setup:
 *   none:    one model request per tool call
 *   gateway: worst case = one search before each new tool; best case = call by name
 *            (tuned: every used tool is pinned, so no searches are needed)
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
const argOf = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const prevDist = argOf("--prev") ?? argOf("--v02");
if (!prevDist || !fs.existsSync(path.join(prevDist, "index.js"))) {
  console.error("Usage: node tests/benchmark-compare.mjs --prev <older dist dir>");
  process.exit(1);
}
const prevVersion = JSON.parse(fs.readFileSync(path.join(prevDist, "..", "package.json"), "utf-8")).version;
const curVersion = JSON.parse(fs.readFileSync("package.json", "utf-8")).version;
const [owner, repo] = (process.env.GITHUB_REPO || "modelcontextprotocol/servers").split("/");
const fileConfig = JSON.parse(fs.readFileSync("config/servers.json", "utf-8"));
const github = fileConfig.mcpServers.github;
const CALL = 40; // tokens the model writes per tool call (same everywhere)

const tasks = [
  { id: "recent-commits", search: "list recent commits", tool: "list_commits", args: { owner, repo, perPage: 10 } },
  { id: "commits-projected", tool: "list_commits", args: { owner, repo, perPage: 30 }, project: ["sha", "commit.message"] },
  { id: "open-issues", search: "list open issues", tool: "list_issues", args: { owner, repo, state: "open", per_page: 20 } },
  { id: "closed-prs", search: "list pull requests", tool: "list_pull_requests", args: { owner, repo, state: "closed", per_page: 10 } },
  { id: "search-repos", search: "search repositories", tool: "search_repositories", args: { query: "model context protocol server", perPage: 10 } },
  { id: "readme", search: "read a file from the repository", tool: "get_file_contents", args: { owner, repo, path: "README.md" } },
  { id: "repeat-commits", tool: "list_commits", args: { owner, repo, perPage: 10 } },
  { id: "count-prs", tool: "list_issues", args: { owner, repo, state: "open", per_page: 30 }, aggregate: true },
  // "Give me an overview: 5 latest commits, open issues and open PRs" (3 calls, or 1 workflow)
  {
    id: "overview",
    multi: [
      { tool: "list_commits", args: { owner, repo, perPage: 5 }, project: ["sha", "commit.message"] },
      { tool: "list_issues", args: { owner, repo, state: "open", per_page: 5 }, project: ["number", "title"] },
      { tool: "list_pull_requests", args: { owner, repo, state: "open", per_page: 5 }, project: ["number", "title"] }
    ],
    workflow: { name: "repo_overview", input: { owner, repo } }
  }
];

const usedTools = ["list_commits", "list_issues", "list_pull_requests", "search_repositories", "get_file_contents"];
const TUNED = {
  discovery: {
    catalog: "groups",
    metaToolStyle: "slim",
    signatureStyle: "oneline",
    alsoStyle: "name",
    pinnedSignatures: [...usedTools.map(t => `github__${t}`), "wf__*"]
  },
  workflows: {
    repo_overview: {
      description: "Latest 5 commits, open issues and open pull requests of a repo in one call. Not for details of one item.",
      input: { properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] },
      steps: [
        { id: "commits", tool: "github__list_commits", arguments: { owner: "${input.owner}", repo: "${input.repo}", perPage: 5 }, fields: ["sha", "commit.message"] },
        { id: "issues", tool: "github__list_issues", arguments: { owner: "${input.owner}", repo: "${input.repo}", state: "open", per_page: 5 }, fields: ["number", "title"] },
        { id: "prs", tool: "github__list_pull_requests", arguments: { owner: "${input.owner}", repo: "${input.repo}", state: "open", per_page: 5 }, fields: ["number", "title"] }
      ],
      output: {
        commits: "${steps.commits}",
        issues: "${steps.issues}",
        prs: "${steps.prs}"
      }
    }
  }
};

async function load(dist) {
  const mod = await import(pathToFileURL(path.join(path.resolve(dist), "index.js")).href);
  return mod.GatewayServer ? mod : mod.default;
}

async function start(api, passthrough, extra = {}) {
  const g = { ...fileConfig.gateway, stats: { enabled: false } };
  const gateway = { ...g, ...extra, discovery: { ...(g.discovery ?? {}), ...(extra.discovery ?? {}) } };
  const config = { ...api.GatewayConfigSchema.parse({ gateway, mcpServers: { github } }), configDir: os.tmpdir() };
  const gw = new api.GatewayServer(config, { passthrough });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gw.connect(b);
  const client = new Client({ name: "bench", version: "1" }, { capabilities: {} });
  await client.connect(a);
  const defsText = JSON.stringify((await client.listTools()).tools) + (client.getInstructions() ?? "");
  return { gw, client, defs: tok(defsText) };
}

const text = r => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");

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

async function runSetup(s, opts) {
  const steps = { worst: [], best: [] };
  const perTask = [];
  for (const t of tasks) {
    let out = 0, search = 0, extra = 0;
    if (t.multi && opts.workflow) {
      const r = await s.client.callTool({ name: "mcp_call_tool", arguments: { tool_name: `wf__${t.workflow.name}`, arguments: t.workflow.input } });
      out = tok(text(r));
      if (r.isError) console.log(`  ! ${t.id}: ${text(r).slice(0, 200)}`);
      steps.worst.push(out + CALL);
      steps.best.push(out + CALL);
    } else {
      const calls = t.multi ?? [{ tool: t.tool, args: t.args, project: t.project }];
      for (const c of calls) {
        const name = `github__${c.tool}`;
        let r;
        if (opts.passthrough) {
          r = await s.client.callTool({ name, arguments: c.args });
        } else {
          r = await s.client.callTool({ name: "mcp_call_tool", arguments: { tool_name: name, arguments: c.args, ...(c.project ? { project_fields: c.project } : {}) } });
        }
        const o = tok(text(r));
        out += o;
        if (r.isError) console.log(`  ! ${t.id}: ${text(r).slice(0, 200)}`);
        if (t.search && !opts.passthrough) {
          search = tok(text(await s.client.callTool({ name: "mcp_search_tools", arguments: { query: t.search, limit: 3 } }))) + CALL;
          steps.worst.push(search);
        }
        steps.worst.push(o + CALL);
        steps.best.push(o + CALL);
        if (t.aggregate && !opts.passthrough) {
          const h = text(r).match(/\[(r\d+):/)?.[1];
          const args = opts.count ? { handle: h, grep: "/pull/", count: true } : { handle: h, fields: ["number", "pull_request.html_url"], limit: 30 };
          if (h) {
            extra = tok(text(await s.client.callTool({ name: "mcp_get_result", arguments: args }))) + CALL;
            steps.worst.push(extra);
            steps.best.push(extra);
          }
        }
      }
    }
    perTask.push({ id: t.id, out, search, extra });
  }
  return { perTask, worst: loop(s.defs, steps.worst), best: loop(s.defs, steps.best), defs: s.defs };
}

async function main() {
  console.log(`Repo ${owner}/${repo} · o200k · ${new Date().toISOString()} · prev v${prevVersion} · current v${curVersion}\n`);
  const prev = await load(prevDist);
  const cur = await load("dist");
  // --only <setup>: re-run one setup and reuse the others from the last saved run
  // (keeps within GitHub's 60 requests/hour without a token).
  const only = argOf("--only");
  const saved = only && fs.existsSync(".zak-gateway/benchmark-compare.json") ? JSON.parse(fs.readFileSync(".zak-gateway/benchmark-compare.json", "utf-8")).results : {};
  const plan = {
    none: () => start(cur, true).then(s => [s, { passthrough: true }]),
    prev: () => start(prev, false).then(s => [s, { count: true }]),
    current: () => start(cur, false).then(s => [s, { count: true }]),
    tuned: () => start(cur, false, TUNED).then(s => [s, { count: true, workflow: true }])
  };
  const setups = {};
  const results = {};
  for (const [k, make] of Object.entries(plan)) {
    if (only && k !== only && saved[k]) {
      results[k] = saved[k];
      continue;
    }
    const [s, opts] = await make();
    setups[k] = s;
    results[k] = await runSetup(s, opts);
  }
  if (only) console.log(`(re-ran "${only}" only; other setups reused from the previous run)\n`);

  const label = { none: "no gateway", prev: `v${prevVersion}`, current: `v${curVersion} (defaults)`, tuned: `v${curVersion} tuned` };
  console.log("task".padEnd(18) + Object.keys(results).map(k => label[k].padStart(18)).join(""));
  tasks.forEach((t, i) => {
    console.log(t.id.padEnd(18) + Object.values(results).map(r => `${r.perTask[i].out}${r.perTask[i].search ? `+${r.perTask[i].search}s` : ""}${r.perTask[i].extra ? `+${r.perTask[i].extra}` : ""}`.padStart(18)).join(""));
  });
  const pct = (base, x) => `${(((base - x) / base) * 100).toFixed(1)}%`;
  console.log("");
  for (const [k, r] of Object.entries(results)) {
    const range = k === "none" ? `${r.best.total}` : `${r.best.total} – ${r.worst.total}`;
    const req = k === "none" ? `${r.best.requests}` : `${r.best.requests} – ${r.worst.requests}`;
    console.log(`${label[k].padEnd(18)} defs/request ${String(r.defs).padStart(5)} · agent-run input ${range.padStart(19)} · requests ${req}${k === "none" ? "" : ` · saves ${pct(results.none.best.total, r.best.total)} (best) vs none`}`);
  }
  fs.mkdirSync(".zak-gateway", { recursive: true });
  fs.writeFileSync(".zak-gateway/benchmark-compare.json", JSON.stringify({ date: new Date().toISOString(), repo: `${owner}/${repo}`, prevVersion, curVersion, label, results }, null, 2));
  for (const s of Object.values(setups)) {
    await s.client.close();
    await s.gw.close();
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
