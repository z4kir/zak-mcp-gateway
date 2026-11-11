#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
import { GatewayServer } from "./server/gateway-server.js";
import { CallRecord, SessionRecord, StatsRecord } from "./stats/token-stats.js";
import { suggestWorkflows } from "./stats/suggestions.js";

const USAGE = `zak-mcp-gateway [--config <servers.json>] [--passthrough]
zak-mcp-gateway init [--config <servers.json>] [--force]
zak-mcp-gateway report [--config <servers.json> | --log <stats.jsonl>] [--session <id>]
zak-mcp-gateway --version | --help

  --config        config file (default: ./config/servers.json)
  --passthrough   expose every downstream tool raw (baseline for A/B measurement)
  init            write a starter config and print how to connect your agent
  report          summarize token savings from the stats log`;

/** Package folder (dist/..): the same from a git clone and from node_modules. */
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

const toSlashes = (p: string) => p.split(path.sep).join("/");

/** Write a minimal working config into the user's project and print how to register the gateway. */
async function init(args: string[]): Promise<void> {
  const relTarget = flag(args, "--config") ?? path.join("config", "servers.json");
  const target = path.resolve(process.cwd(), relTarget);
  const exists = await fs.access(target).then(() => true, () => false);
  if (exists && !args.includes("--force")) {
    throw new Error(`${target} already exists; pass --force to overwrite it.`);
  }

  // Relative paths in the config resolve against its folder; keep the stats log in <project>/.zak-gateway/.
  const statsLog = toSlashes(path.relative(path.dirname(target), path.join(process.cwd(), ".zak-gateway", "stats.jsonl")));
  const starter = {
    gateway: { stats: { enabled: true, logFile: statsLog } },
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
      }
    }
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(starter, null, 2) + "\n", "utf-8");

  // Native Windows hosts cannot spawn npx directly; it needs the cmd /c wrapper.
  const npxArgs = ["-y", "zak-mcp-gateway", "--config", toSlashes(target)];
  const entry = process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...npxArgs] } : { command: "npx", args: npxArgs };
  const snippet = [
    `{`,
    `  "mcpServers": {`,
    `    "zak-gateway": {`,
    `      "command": ${JSON.stringify(entry.command)},`,
    `      "args": [${entry.args.map(a => JSON.stringify(a)).join(", ")}]`,
    `    }`,
    `  }`,
    `}`
  ].map(line => `     ${line}`).join("\n");

  console.log(`Created ${target} with one example server (GitHub).

Next:
  1. Add your MCP servers under "mcpServers" (same shape as in any MCP client config).
     Full reference with every option: ${toSlashes(path.join(PACKAGE_ROOT, "config", "servers.example.json"))}
     Keep secrets out of the file: write "\${MY_TOKEN}" and set MY_TOKEN in the environment.
  2. Register only the gateway with your agent (.mcp.json for Claude Code, claude_desktop_config.json,
     .cursor/mcp.json, ...) and remove the direct entries for the servers it now fronts:
${snippet}
  3. Add .zak-gateway/ to .gitignore (local token-savings log).
     See the savings later with: npx zak-mcp-gateway report --config ${toSlashes(relTarget)}`);
}

async function serve(args: string[]): Promise<void> {
  const config = await loadConfig(flag(args, "--config"));
  const server = new GatewayServer(config, { passthrough: args.includes("--passthrough") });
  await server.start();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

async function report(args: string[]): Promise<void> {
  let logPath = flag(args, "--log");
  if (!logPath) {
    const config = await loadConfig(flag(args, "--config"));
    logPath = path.resolve(config.configDir, config.gateway.stats.logFile);
  }
  const text = await fs.readFile(logPath, "utf-8").catch(() => "");
  const records = text.split("\n").filter(Boolean).map(l => JSON.parse(l) as StatsRecord);
  const onlySession = flag(args, "--session");
  const sessions = records.filter((r): r is SessionRecord => r.type === "session" && (!onlySession || r.session === onlySession));
  const calls = records.filter((r): r is CallRecord => r.type === "call" && (!onlySession || r.session === onlySession));

  if (records.length === 0) {
    console.log(`No stats yet in ${logPath}`);
    return;
  }

  const sum = (xs: CallRecord[], k: "rawTokens" | "sentTokens") => xs.reduce((s, c) => s + c[k], 0);
  const pct = (saved: number, base: number) => (base ? `${((saved / base) * 100).toFixed(1)}%` : "-");

  console.log(`Stats log: ${logPath}`);
  console.log(`Sessions: ${sessions.length}   Calls: ${calls.length}   Cache hits: ${calls.filter(c => c.cacheHit).length}   Blocked/errors: ${calls.filter(c => c.blocked).length}\n`);

  if (sessions.length) {
    const last = sessions[sessions.length - 1];
    console.log("Tool definitions sent with every model request (latest session):");
    console.log(`  direct MCP: ~${last.baselineSchemaTokens} tokens   via gateway: ~${last.gatewaySchemaTokens} tokens   saved: ${pct(last.baselineSchemaTokens - last.gatewaySchemaTokens, last.baselineSchemaTokens)}\n`);
  }

  const byTool = new Map<string, CallRecord[]>();
  for (const c of calls) {
    const key = `${c.via}:${c.tool}`;
    if (!byTool.has(key)) byTool.set(key, []);
    byTool.get(key)!.push(c);
  }
  console.log("Results returned to the model:");
  console.log(`  ${"via:tool".padEnd(48)} ${"calls".padStart(5)} ${"raw".padStart(9)} ${"sent".padStart(9)} ${"saved".padStart(7)}`);
  for (const [key, cs] of [...byTool].sort((a, b) => sum(b[1], "rawTokens") - sum(a[1], "rawTokens"))) {
    const raw = sum(cs, "rawTokens");
    const sent = sum(cs, "sentTokens");
    console.log(`  ${key.slice(0, 48).padEnd(48)} ${String(cs.length).padStart(5)} ${String(raw).padStart(9)} ${String(sent).padStart(9)} ${pct(raw - sent, raw).padStart(7)}`);
  }
  const raw = sum(calls, "rawTokens");
  const sent = sum(calls, "sentTokens");
  console.log(`\n  TOTAL raw ~${raw} tokens, sent ~${sent} tokens, saved ${pct(raw - sent, raw)} (search/get_result overhead included in "sent")`);

  // Turns and overhead: every tool call is one more model request that re-sends the history.
  const byVia = new Map<string, CallRecord[]>();
  for (const c of calls) {
    if (!byVia.has(c.via)) byVia.set(c.via, []);
    byVia.get(c.via)!.push(c);
  }
  console.log("\nTurns by kind (each is one model request):");
  for (const [via, cs] of [...byVia].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${via.padEnd(12)} ${String(cs.length).padStart(5)} calls  ${String(sum(cs, "sentTokens")).padStart(8)} tokens sent`);
  }

  // Learned default fields: what agents keep asking for from stored results, per tool.
  const asked = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (c.via !== "get_result" || !c.fieldsUsed?.length) continue;
    if (!asked.has(c.tool)) asked.set(c.tool, new Map());
    for (const f of c.fieldsUsed) asked.get(c.tool)!.set(f, (asked.get(c.tool)!.get(f) ?? 0) + 1);
  }
  const suggestions = [...asked]
    .map(([tool, fields]) => [tool, [...fields].filter(([, n]) => n >= 2).map(([f]) => f)] as const)
    .filter(([, fields]) => fields.length > 0);
  if (suggestions.length) {
    console.log("\nSuggested default fields (asked for 2+ times; copy into the server's \"projections\" if they fit):");
    for (const [tool, fields] of suggestions) {
      const [server, name] = tool.split("__");
      console.log(`  ${server}.projections.${name}: ${JSON.stringify(fields)}`);
    }
  }

  const flows = suggestWorkflows(calls);
  if (flows.length) {
    console.log("\nSuggested workflows (the same call sequence seen 2+ times; fill in the arguments, review, then add to gateway.workflows):");
    for (const f of flows) {
      console.log(`  seen ${f.count}×: ${f.steps.map(s => (s.repeat > 1 ? `${s.tool} ×${s.repeat}` : s.tool)).join(" → ")}`);
      console.log(`  ${JSON.stringify(f.skeleton)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(await packageVersion());
    return;
  }
  if (args[0] === "init") return init(args.slice(1));
  if (args[0] === "report") return report(args.slice(1));
  return serve(args);
}

main().catch(err => {
  console.error("[zak-gateway] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
