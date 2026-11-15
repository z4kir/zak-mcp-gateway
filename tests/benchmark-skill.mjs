/**
 * Benchmark for the zak-mcp-gateway skill: the same 5 read-only tasks on PUBLIC MCP servers,
 * with and without the gateway, counted with the o200k tokenizer.
 *
 *   1. In an empty folder, follow skills/zak-mcp-gateway/SKILL.md (install, init, add the
 *      github + filesystem servers, write .mcp.json).
 *   2. node tests/benchmark-skill.mjs --project <that folder>
 *
 * Without gateway: an MCP client connects straight to every server in <project>/config/servers.json.
 * With gateway:    the client starts exactly the "zak-gateway" entry of <project>/.mcp.json
 *                  (the published npm package), and follows the skill's usage rules.
 * Public data only: GitHub repo modelcontextprotocol/servers (no token needed) and the
 * project's own copy of the zak-mcp-gateway npm package. Nothing is written.
 * Results: printed, and saved to .zak-gateway/benchmark-skill.json.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("o200k_base");
const tok = s => enc.encode(s).length;
const projectArg = process.argv.includes("--project") ? process.argv[process.argv.indexOf("--project") + 1] : undefined;
if (!projectArg) {
  console.error("Usage: node tests/benchmark-skill.mjs --project <folder set up with the skill>");
  process.exit(1);
}
const project = path.resolve(projectArg);
const P = project.split(path.sep).join("/");
const config = JSON.parse(fs.readFileSync(path.join(project, "config", "servers.json"), "utf-8"));
const entry = JSON.parse(fs.readFileSync(path.join(project, ".mcp.json"), "utf-8")).mcpServers["zak-gateway"];
const { resolveSecretMap } = createRequire(path.join(project, "package.json"))("zak-mcp-gateway");
const gwVersion = JSON.parse(fs.readFileSync(path.join(project, "node_modules", "zak-mcp-gateway", "package.json"), "utf-8")).version;
const text = r => (r.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
const CALL = 40; // tokens the model writes for one tool call (same in both setups)
const repo = { owner: "modelcontextprotocol", repo: "servers" };

/**
 * Each task: the user's question, the direct call, and what an agent following the skill sends
 * through the gateway (`project` = project_fields, `followUp` = a get_result call on the handle).
 */
const tasks = [
  {
    id: "recent-commits", question: "What changed recently in modelcontextprotocol/servers?",
    server: "github", tool: "list_commits", args: { ...repo, perPage: 10 },
    search: "list recent commits", project: ["sha", "commit.message", "commit.author.name", "commit.author.date"]
  },
  {
    id: "open-issues", question: "Which open issues are there, and who opened them?",
    server: "github", tool: "list_issues", args: { ...repo, state: "open", per_page: 30 },
    search: "list open issues", project: ["number", "title", "user.login"]
  },
  {
    id: "search-repos", question: "Find repositories about MCP gateways.",
    server: "github", tool: "search_repositories", args: { query: "mcp gateway", perPage: 10 },
    search: "search repositories", project: ["total_count", "items.full_name", "items.description"]
  },
  {
    id: "package-files", question: "Which files does the zak-mcp-gateway package ship?",
    server: "filesystem", tool: "directory_tree", args: { path: `${P}/node_modules/zak-mcp-gateway` },
    search: "show a directory tree"
  },
  {
    id: "readme-install", question: "How do I install zak-mcp-gateway, according to its README?",
    server: "filesystem", tool: "read_text_file", args: { path: `${P}/node_modules/zak-mcp-gateway/README.md` },
    search: "read a text file", followUp: { grep: "npm install|npx zak-mcp-gateway init", limit: 12 }
  }
];

async function connect(command, args, env) {
  const client = new Client({ name: "bench-skill", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command, args, env, cwd: project, stderr: "ignore" }));
  return client;
}

function processEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  return env;
}

/** Every model request re-sends the tool definitions and all history so far (no trimming). */
function agentLoop(defs, steps) {
  let history = 0, input = 0, requests = 0;
  const request = added => { input += defs + history; requests++; history += added; };
  for (const s of steps) for (const added of s) request(added);
  request(0); // final answer
  return { requests, input };
}

async function main() {
  console.log(`Project: ${project}\nGateway: zak-mcp-gateway ${gwVersion} via ${entry.command} ${entry.args.join(" ")}\n`);

  // ---- without gateway: one client per server ----
  const direct = {};
  for (const [id, s] of Object.entries(config.mcpServers)) {
    direct[id] = await connect(s.command, s.args, { ...processEnv(), ...resolveSecretMap(id, s.env, "env") });
  }
  const directTools = [];
  let directInstructions = "";
  for (const [id, c] of Object.entries(direct)) {
    directTools.push(...(await c.listTools()).tools);
    directInstructions += c.getInstructions() ?? "";
    void id;
  }
  const defsDirect = tok(JSON.stringify({ tools: directTools })) + tok(directInstructions);

  // ---- with gateway: exactly the .mcp.json entry ----
  const gw = await connect(entry.command, entry.args, processEnv());
  const gwTools = (await gw.listTools()).tools;
  const defsGateway = tok(JSON.stringify({ tools: gwTools })) + tok(gw.getInstructions() ?? "");

  const rows = [];
  for (const t of tasks) {
    const d = await direct[t.server].callTool({ name: t.tool, arguments: t.args });
    const s = await gw.callTool({ name: "mcp_search_tools", arguments: { query: t.search } });
    const found = text(s).includes(`${t.server}__${t.tool}(`);
    const g = await gw.callTool({
      name: "mcp_call_tool",
      arguments: { tool_name: `${t.server}__${t.tool}`, arguments: t.args, ...(t.project ? { project_fields: t.project } : {}) }
    });
    // Same call without project_fields: what an agent gets when it ignores the skill's rule 2.
    // Identical reads are answered from the gateway cache, so this adds no downstream call.
    const plain = t.project
      ? await gw.callTool({ name: "mcp_call_tool", arguments: { tool_name: `${t.server}__${t.tool}`, arguments: t.args } })
      : g;
    const handle = text(g).match(/\[(r\d+)[:\s]/)?.[1];
    let follow = null;
    if (t.followUp && handle) {
      const f = await gw.callTool({ name: "mcp_get_result", arguments: { handle, ...t.followUp } });
      follow = { tokens: tok(text(f)), preview: text(f).slice(0, 300), error: !!f.isError };
    }
    const row = {
      id: t.id,
      question: t.question,
      call: `${t.server}__${t.tool}`,
      direct: tok(text(d)),
      gateway: tok(text(g)),
      gatewayNoProjection: tok(text(plain)),
      followUp: follow?.tokens ?? 0,
      search: tok(text(s)),
      searchFound: found,
      handle: handle ?? null,
      errors: { direct: !!d.isError, gateway: !!g.isError, followUp: follow?.error ?? false },
      gatewayPreview: text(g).slice(0, 300),
      followUpPreview: follow?.preview ?? null
    };
    rows.push(row);
    console.log(
      `${t.id.padEnd(15)} direct ${String(row.direct).padStart(6)}   gateway ${String(row.gateway).padStart(5)}` +
        `${t.project ? ` (no project_fields: ${row.gatewayNoProjection})` : ""}` +
        `${row.followUp ? ` + follow-up ${row.followUp}` : ""}   (search ${row.search}${found ? "" : " NOT FOUND"})` +
        `${d.isError || g.isError ? "   ERROR: " + text(d.isError ? d : g).slice(0, 160) : ""}`
    );
  }

  // Agent runs: tokens added to the history by each model request.
  const directSteps = rows.map(r => [r.direct + CALL]);
  const byName = rows.map(r => [r.gateway + CALL, ...(r.followUp ? [r.followUp + CALL] : [])]);
  const searching = rows.map(r => [r.search + CALL, r.gateway + CALL, ...(r.followUp ? [r.followUp + CALL] : [])]);
  const noRules = rows.map(r => [r.search + CALL, r.gatewayNoProjection + CALL, ...(r.followUp ? [r.followUp + CALL] : [])]);
  const runs = {
    direct: agentLoop(defsDirect, directSteps),
    gatewayByName: agentLoop(defsGateway, byName),
    gatewaySearching: agentLoop(defsGateway, searching),
    gatewayNoProjection: agentLoop(defsGateway, noRules)
  };
  const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);

  console.log(`\nTool definitions per model request: direct ${defsDirect} (${directTools.length} tools)   gateway ${defsGateway} (${gwTools.length} tools)   saved ${pct(defsDirect, defsGateway)}`);
  console.log(`Tool replies, 5 tasks:              direct ${sum("direct")}   gateway ${sum("gateway") + sum("followUp")} (incl. follow-ups)   saved ${pct(sum("direct"), sum("gateway") + sum("followUp"))}`);
  for (const [k, v] of Object.entries(runs)) {
    console.log(`Agent run (${k.padEnd(16)}): ${String(v.requests).padStart(2)} model requests, ${String(v.input).padStart(7)} input tokens${k === "direct" ? "" : `   saved ${pct(runs.direct.input, v.input)}`}`);
  }

  const out = { date: new Date().toISOString(), gatewayVersion: gwVersion, tokenizer: "o200k_base", callOverhead: CALL, defs: { direct: defsDirect, gateway: defsGateway, directTools: directTools.length, gatewayTools: gwTools.length }, rows, runs };
  fs.mkdirSync(".zak-gateway", { recursive: true });
  fs.writeFileSync(".zak-gateway/benchmark-skill.json", JSON.stringify(out, null, 2));
  console.log("\nSaved .zak-gateway/benchmark-skill.json");

  await gw.close();
  for (const c of Object.values(direct)) await c.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
