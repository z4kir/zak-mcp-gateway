#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
import { GatewayServer } from "./server/gateway-server.js";
import { CallRecord, SessionRecord, StatsRecord } from "./stats/token-stats.js";

const USAGE = `zak-mcp-gateway [--config <servers.json>] [--passthrough]
zak-mcp-gateway report [--config <servers.json> | --log <stats.jsonl>] [--session <id>]

  --passthrough   expose every downstream tool raw (baseline for A/B measurement)
  report          summarize token savings from the stats log`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
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
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (args[0] === "report") return report(args.slice(1));
  return serve(args);
}

main().catch(err => {
  console.error("[zak-gateway] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
