import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startGateway } from "./helpers.mjs";
import {
  buildCatalog,
  groupNames,
  EgressDistiller,
  ResultStore,
  GatewayResultsConfigSchema,
  IdempotencyGuard,
  estimateTokens,
  getPath
} from "../dist/index.js";

const githubTools = JSON.parse(fs.readFileSync(new URL("./fixtures/github-tools.json", import.meta.url))).map(t => ({
  serverId: "github", name: t.name, namespacedName: `github__${t.name}`, description: t.description,
  inputSchema: t.inputSchema, access: IdempotencyGuard.classify(t.name, t.annotations)
}));

// ============================== Phase A ==============================

test("A1 per-server limits: light mode keeps a compact reply inline as JSON; default mode pages it", async t => {
  const light = await startGateway({ server: { results: { inlineTokenLimit: 8000, distill: "light" } } });
  t.after(light.close);
  const r = await light.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: {} });
  assert.match(r.text, /^\[\{"id":0,"t":"item 0","s":"done"\}/);
  assert.ok(!r.text.includes("mcp_get_result"), "no handle, no paging");

  const dflt = await startGateway();
  t.after(dflt.close);
  const d = await dflt.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: {} });
  assert.match(d.text, /showing \d+ of 400 rows/);
});

test("A1 distill off passes the server's text through untouched (pretty JSON kept)", async t => {
  const g = await startGateway({ server: { results: { distill: "off" } } });
  t.after(g.close);
  const r = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "u" } });
  assert.match(r.text, /^\[\n  \{\n    "id": 1,/);
  assert.match(r.text, /"avatar_url"/);
});

test("A2 compact search: top hit in full, the rest as name + summary; detail:full shows all", async t => {
  const g = await startGateway();
  t.after(g.close);
  const compact = await g.call("mcp_search_tools", { query: "read database rows log", limit: 3 });
  const sigs = compact.text.match(/^testdb__\w+\(/gm) ?? [];
  assert.equal(sigs.length, 1, compact.text);
  assert.match(compact.text, /also:\n- testdb__\w+: /);
  const full = await g.call("mcp_search_tools", { query: "read database rows log", limit: 3, detail: "full" });
  const fullCount = (full.text.match(/^testdb__\w+\(/gm) ?? []).length;
  assert.ok(fullCount >= 2, full.text);
  assert.equal((compact.text.match(/^- testdb__/gm) ?? []).length, fullCount - 1, "same hits, only the format differs");
  assert.ok(estimateTokens(compact.text) < estimateTokens(full.text));
});

test("A3 the downstream server's own instructions are forwarded (and can be switched off)", async t => {
  const g = await startGateway();
  t.after(g.close);
  assert.match(g.client.getInstructions(), /\[testdb notes\] Mock DB notes: table names are lowercase/);
  const off = await startGateway({ server: { forwardInstructions: false } });
  t.after(off.close);
  assert.ok(!off.client.getInstructions().includes("Mock DB notes"));
});

test("A4 catalog modes: names, groups, servers, off", () => {
  const names = buildCatalog(githubTools, "names").join("\n");
  const groups = buildCatalog(githubTools, "groups").join("\n");
  const servers = buildCatalog(githubTools, "servers").join("\n");
  assert.match(names, /create_or_update_file, search_repositories/);
  assert.match(groups, /\{create,get,list,search,update\}_issue/);
  assert.match(groups, /\{create,get,list,merge\}_pull_request/);
  assert.ok(estimateTokens(groups) <= estimateTokens(names), "groups is not bigger than names");
  assert.equal(servers, "github (prefix github__): 26 tools");
  assert.deepEqual(buildCatalog(githubTools, "off"), []);
  assert.equal(groupNames(["incident_create", "incident_list", "get_incidents", "ping"]), "incident_{create,list} get_incidents ping");
});

test("A4 groups mode resolves singular/plural guesses (list_issue -> list_issues style)", async t => {
  const g = await startGateway({ gateway: { discovery: { catalog: "groups" } } });
  t.after(g.close);
  assert.match(g.client.getInstructions(), /\{a,b\}_x means a_x and b_x/);
  const r = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_logs", arguments: { lines: 3 } });
  assert.ok(!r.isError, r.text);
});

test("A5 per-server synonyms extend search vocabulary", async t => {
  const without = await startGateway();
  t.after(without.close);
  const miss = await without.call("mcp_search_tools", { query: "ledger" });
  assert.match(miss.text, /No tools matched/);
  const withSyn = await startGateway({ server: { synonyms: { ledger: ["database"] } } });
  t.after(withSyn.close);
  const hit = await withSyn.call("mcp_search_tools", { query: "ledger" });
  assert.match(hit.text, /testdb__mock_read_db\(/);
});

test("A6 raw paging says CLIPPED when a page does not fit", () => {
  const egress = new EgressDistiller(GatewayResultsConfigSchema.parse({}), new ResultStore());
  const text = "short line\n" + "x ".repeat(5000) + "\nend";
  egress.process({ content: [{ type: "text", text }] }, { toolName: "s__t", serverId: "s", inlineTokenLimit: 100, warnOnInjection: false });
  const page = egress.getResult({ handle: "r1", raw: true }, 200);
  assert.match(page.text, /CLIPPED at the token budget/);
});

test("json-path helper: dots, indexes, [key=value] filters", () => {
  const v = { files: [{ name: "a", content: "A" }, { name: "readme", content: "R" }], meta: { n: 1 } };
  assert.deepEqual(getPath(v, "files[1].content"), { found: true, value: "R" });
  assert.deepEqual(getPath(v, "files[name=readme].content"), { found: true, value: "R" });
  assert.deepEqual(getPath(v, "meta.n"), { found: true, value: 1 });
  assert.equal(getPath(v, "files[5].content").found, false);
});

// ============================== Phase B ==============================

test("B1 hot signatures: most-used tools from the stats log go into the instructions", async t => {
  const first = await startGateway();
  t.after(first.close);
  for (let i = 0; i < 3; i++) await first.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: `t${i}` } });
  await first.call("mcp_call_tool", { tool_name: "testdb__mock_read_log", arguments: { lines: 2 } });
  await new Promise(r => setTimeout(r, 100)); // stats are appended asynchronously

  // A new session reading the same log
  const { GatewayServer, GatewayConfigSchema } = await import("../dist/index.js");
  const fs = await import("node:fs");
  const config = { ...GatewayConfigSchema.parse({ gateway: { stats: { logFile: "stats.jsonl" }, discovery: { hotSignatures: 1 } }, mcpServers: {} }), configDir: first.tmp };
  const g2 = new GatewayServer(config);
  // reuse the first session's pool so the tool exists in this catalog
  g2.pool.getTool = n => first.gateway.pool.getTool(n);
  await g2.initialize();
  assert.match(g2.getInstructions(), /Frequently used \(call directly\):\ntestdb__mock_read_db\(\{ table: string, perPage\?: number \}\)$/);
  assert.ok(fs.existsSync(`${first.tmp}/stats.jsonl`));
  await g2.close();
});

test("B2 batch: reads run in one turn; writes need one confirmation for the whole batch", async t => {
  const g = await startGateway();
  t.after(g.close);
  const reads = await g.call("mcp_call_tool", {
    calls: [
      { tool_name: "testdb__mock_read_db", arguments: { table: "a" }, project_fields: ["id"] },
      { tool_name: "testdb__mock_read_log", arguments: { lines: 2 } }
    ]
  });
  assert.ok(!reads.isError, reads.text);
  assert.match(reads.text, /^\[0\] testdb__mock_read_db ok: id\n1\n2\n\[1\] testdb__mock_read_log ok: 1 INFO/);

  const calls = [
    { tool_name: "testdb__mock_write_db", arguments: { table: "a", data: { v: 1 } } },
    { tool_name: "testdb__mock_write_db", arguments: { table: "a", data: { v: 2 } } }
  ];
  const preview = await g.call("mcp_call_tool", { calls });
  assert.equal(preview.isError, true);
  assert.match(preview.text, /Batch not run: 2 of 2 calls change data:\n\[0\] testdb__mock_write_db/);
  const done = await g.call("mcp_call_tool", { calls, confirm: true });
  assert.match(done.text, /\[0\] testdb__mock_write_db ok: .*\n\[1\] testdb__mock_write_db ok: /);
});

test("B2 batch stops at the first error and says exactly where", async t => {
  const g = await startGateway();
  t.after(g.close);
  const r = await g.call("mcp_call_tool", {
    calls: [
      { tool_name: "testdb__mock_read_db", arguments: { table: "a" } },
      { tool_name: "testdb__mock_read_db", arguments: {} },
      { tool_name: "testdb__mock_read_log", arguments: { lines: 1 } }
    ]
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /\[1\] testdb__mock_read_db ERROR: Invalid arguments[\s\S]*Stopped at \[1\]; calls \[2\.\.2\] were not run\.$/);
});

test("B3 default arguments are pushed down when the agent omits them, agent values win", async t => {
  const g = await startGateway({ server: { defaultArgs: { mock_read_db: { perPage: 3 } } } });
  t.after(g.close);
  const dflt = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "a" }, project_fields: ["id"] });
  assert.match(dflt.text, /^id\n1\n2\n3$/);
  const own = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "a", perPage: 2 }, project_fields: ["id"] });
  assert.match(own.text, /^id\n1\n2$/);
});

test("B4 aggregation on handles: count, group_by, distinct, sort", async t => {
  const g = await startGateway();
  t.after(g.close);
  const big = await g.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: { n: 400 } });
  const h = big.text.match(/\[(r\d+): showing/)[1];
  assert.match((await g.call("mcp_get_result", { handle: h, count: true })).text, /count: 400 rows$/);
  assert.match((await g.call("mcp_get_result", { handle: h, count: true, grep: "done" })).text, /count: 134 rows matching grep \(of 400\)/);
  const grouped = await g.call("mcp_get_result", { handle: h, group_by: "s" });
  assert.match(grouped.text, /s\tcount\nopen\t266\ndone\t134$/);
  const distinct = await g.call("mcp_get_result", { handle: h, distinct: "s" });
  assert.match(distinct.text, /2 distinct s over 400 rows\ndone, open$/);
  const sorted = await g.call("mcp_get_result", { handle: h, sort: "-id", limit: 2, fields: ["id"] });
  assert.match(sorted.text, /\nid\n399\n398$/);
});

// ============================== Phase C ==============================

const readCalls = async g => JSON.parse((await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_calls", arguments: { n: Math.random() } })).text).readCalls;

test("C1 per-tool access override and writeIf rules", async t => {
  const g = await startGateway({ server: { access: { mock_get_note: "write" }, writeIf: { mock_read_db: { table: "audit" } } } });
  t.after(g.close);
  const note = await g.call("mcp_call_tool", { tool_name: "testdb__mock_get_note", arguments: { id: "1" } });
  assert.match(note.text, /changes data\. Confirm with the user/);
  const normal = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "users" } });
  assert.ok(!normal.isError);
  const audit = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "audit" } });
  assert.match(audit.text, /changes data/, "same tool becomes a write for matching arguments");
});

test("C1 cache: per-server off switch and fresh:true", async t => {
  const on = await startGateway();
  t.after(on.close);
  const a = await readCalls(on);
  await on.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" } });
  await on.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" } });
  assert.equal(await readCalls(on), a + 1, "second read cached");
  await on.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" }, fresh: true });
  assert.equal(await readCalls(on), a + 2, "fresh bypasses the cache");

  const off = await startGateway({ server: { cache: false } });
  t.after(off.close);
  const b = await readCalls(off);
  await off.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" } });
  await off.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" } });
  assert.equal(await readCalls(off), b + 2, "cache: false always calls the server");
});

test("C1 cacheGroup: a write on one server clears cached reads of another server in the group", async t => {
  const { mockServerPath } = await import("./helpers.mjs");
  const g = await startGateway({
    server: { cacheGroup: "backend" },
    extraServers: { other: { command: "node", args: [mockServerPath], cacheGroup: "backend" } }
  });
  t.after(g.close);
  const first = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" }, project_fields: ["written"] });
  await g.call("mcp_call_tool", { tool_name: "other__mock_write_db", arguments: { table: "x", data: {} }, confirm: true });
  const again = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x" }, project_fields: ["written"] });
  // testdb's own write count did not change, but the cached copy was dropped and re-read
  assert.equal(first.text, again.text);
  const s = g.gateway.stats.summary();
  assert.equal(s.cacheHits, 0, "the second read was not served from cache");
});

test("C2 write receipts: short {ok,id} reply, full echo behind a handle, full:true restores it", async t => {
  const g = await startGateway({ server: { results: { writeReceipts: true } } });
  t.after(g.close);
  const data = { id: 7, name: "Widget", notes: "lorem ipsum ".repeat(200) };
  const r = await g.call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "t", data }, confirm: true });
  assert.match(r.text, /^\{"ok":true,"id":7,"name":"Widget"\}\n\[(r\d+): full reply\]$/);
  const h = r.text.match(/\[(r\d+): full reply\]/)[1];
  const echo = await g.call("mcp_get_result", { handle: h, path: "inserted.notes" });
  assert.match(echo.text, /lorem ipsum/);
  const full = await g.call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "t", data }, confirm: true, full: true });
  assert.match(full.text, /"success":true/);
});

test("C3 path: one field in full, with offset paging when it is long", async t => {
  const g = await startGateway({ gateway: { results: { inlineTokenLimit: 200 } } });
  t.after(g.close);
  const big = await g.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: { n: 300 } });
  const h = big.text.match(/\[(r\d+): showing/)[1];
  const one = await g.call("mcp_get_result", { handle: h, path: "[name=x].t" });
  assert.equal(one.isError, true);
  const field = await g.call("mcp_get_result", { handle: h, path: "[42].t" });
  assert.match(field.text, /^\[r\d+ \[42\]\.t: chars 0-7 of 7\]\nitem 42$/);
  const page = await g.call("mcp_get_result", { handle: h, path: "[id=5]", max_tokens: 5 });
  assert.match(page.text, /CLIPPED at max_tokens; continue with offset \d+/);
});

test("C3 $ref: stored data flows into another call without passing through the model; patches apply", async t => {
  const g = await startGateway({ server: { results: { writeReceipts: false } } });
  t.after(g.close);
  const src = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "x", perPage: 40 } });
  const h = src.text.match(/\[(r\d+):/)[1];

  const copy = await g.call("mcp_call_tool", {
    tool_name: "testdb__mock_write_db",
    arguments: { table: "copy", data: { $ref: h, path: "[0]" } },
    confirm: true
  });
  assert.match(copy.text, /"inserted":\{"id":1,"name":"User 1"/);

  const patched = await g.call("mcp_call_tool", {
    tool_name: "testdb__mock_write_db",
    arguments: { table: "t", data: { label: { $ref: h, path: "[2].email", replace: [{ find: "example.com", replace: "corp.io" }] } } },
    confirm: true
  });
  assert.match(patched.text, /"label":"user3@corp\.io"/);

  const missing = await g.call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "t", data: { $ref: "r999" } }, confirm: true });
  assert.match(missing.text, /\$ref r999 is unknown or expired/);
  const ambiguous = await g.call("mcp_call_tool", {
    tool_name: "testdb__mock_write_db",
    arguments: { table: "t", data: { v: { $ref: h, path: "[0].email", replace: [{ find: "e", replace: "E" }] } } },
    confirm: true
  });
  assert.match(ambiguous.text, /matches \d+ times; use a longer "find" or all: true/);
});

// ============================== Phase D ==============================

test("D1 rules and skills reach any client: instructions, mcp_get_skill, skill hint in search", async t => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fsx = await import("node:fs");
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), "zak-skills-"));
  fsx.mkdirSync(path.join(dir, "skills", "close-incident"), { recursive: true });
  fsx.writeFileSync(path.join(dir, "skills", "close-incident", "SKILL.md"), "---\nname: close-incident\ndescription: Close a resolved incident with a work note\n---\n1. Read the incident.\n2. Add a work note.\n3. Set state to closed.");
  fsx.writeFileSync(path.join(dir, "skills", "weekly-report.md"), "# Weekly report\nBuild the weekly database report from read_db rows.\n");
  fsx.writeFileSync(path.join(dir, "rules.md"), "Always show record ids.\nNever delete records.");

  const g = await startGateway({ gateway: { knowledge: { rulesFile: path.join(dir, "rules.md"), skillsDir: path.join(dir, "skills") } } });
  t.after(g.close);
  const instructions = g.client.getInstructions();
  assert.match(instructions, /Rules:\nAlways show record ids\.\nNever delete records\./);
  assert.match(instructions, /- close-incident: Close a resolved incident with a work note\n- weekly-report: Build the weekly database report from read_db rows\./);
  assert.ok((await g.client.listTools()).tools.some(x => x.name === "mcp_get_skill"));

  const skill = await g.call("mcp_get_skill", { name: "close-incident" });
  assert.match(skill.text, /^# close-incident\n1\. Read the incident\./);
  const hint = await g.call("mcp_search_tools", { query: "close the resolved incident" });
  assert.match(hint.text, /^Relevant skill: close-incident/);
  const noHint = await g.call("mcp_search_tools", { query: "tail the log lines" });
  assert.ok(!noHint.text.startsWith("Relevant skill"), noHint.text);

  const plain = await startGateway();
  t.after(plain.close);
  assert.ok(!(await plain.client.listTools()).tools.some(x => x.name === "mcp_get_skill"), "no skills -> no extra tool");
});

test("D2 elicitation and sampling from a downstream server reach the agent's client", async t => {
  const { ElicitRequestSchema, CreateMessageRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const g = await startGateway({
    gateway: { clientFeatures: { elicitation: true, sampling: true } },
    clientCapabilities: { elicitation: {}, sampling: {} },
    setupClient: client => {
      client.setRequestHandler(ElicitRequestSchema, async req => ({ action: "accept", content: { approve: req.params.message.includes("cached") } }));
      client.setRequestHandler(CreateMessageRequestSchema, async () => ({ role: "assistant", content: { type: "text", text: "SHORT" }, model: "test-model" }));
    }
  });
  t.after(g.close);
  const ask = await g.call("mcp_call_tool", { tool_name: "testdb__mock_get_approval", arguments: {} });
  assert.equal(ask.text, '{"action":"accept","content":{"approve":true}}');
  const sum = await g.call("mcp_call_tool", { tool_name: "testdb__mock_get_summary", arguments: { text: "long text" } });
  assert.equal(sum.text, "summary=SHORT");

  // Agent client without elicitation support: the gateway declines on its behalf
  const noUi = await startGateway({ gateway: { clientFeatures: { elicitation: true } } });
  t.after(noUi.close);
  const declined = await noUi.call("mcp_call_tool", { tool_name: "testdb__mock_get_approval", arguments: {} });
  assert.equal(declined.text, '{"action":"decline"}');

  // Feature off (default): the downstream server sees no elicitation capability at all
  const off = await startGateway();
  t.after(off.close);
  assert.equal((await off.call("mcp_call_tool", { tool_name: "testdb__mock_get_approval", arguments: {} })).text, "no elicitation support");
});

test("D4 code mode runs in a locked-down process: no file system, no fetch, hard timeout", async t => {
  const g = await startGateway({ gateway: { codeMode: { enabled: true, timeoutMs: 3000 } } });
  t.after(g.close);
  const fsTry = await g.call("mcp_run_code", { code: "return process.mainModule.require('fs').readFileSync('package.json','utf8').length" });
  assert.equal(fsTry.isError, true);
  assert.match(fsTry.text, /ERR_ACCESS_DENIED|Access to this API has been restricted/i);
  const net = await g.call("mcp_run_code", { code: "return typeof fetch" });
  assert.match(net.text, /^"undefined"/);
  const started = Date.now();
  const loop = await g.call("mcp_run_code", { code: "while (true) {}" });
  assert.match(loop.text, /timed out after 3000ms/);
  assert.ok(Date.now() - started < 6000);
  const ok = await g.call("mcp_run_code", { code: "const r = await call('testdb__mock_read_db', {table:'u', perPage: 5}); return r.map(x => x.id)" });
  assert.match(ok.text, /^\[1,2,3,4,5\]/);
});

test("D5 dedupe: an identical repeat result is a one-line pointer", async t => {
  const g = await startGateway({ gateway: { results: { dedupe: true } }, server: { cache: false } });
  t.after(g.close);
  const first = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_log", arguments: { lines: 20 } });
  assert.match(first.text, /^1 INFO/);
  const again = await g.call("mcp_call_tool", { tool_name: "testdb__mock_read_log", arguments: { lines: 20 } });
  assert.match(again.text, /^\[unchanged: identical to an earlier result of this call \(r\d+\)\]$/);
});

test("D5 report: turns by kind and suggested default fields from get_result usage", async t => {
  const g = await startGateway({ gateway: { results: { inlineTokenLimit: 200 } } });
  const big = await g.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: { n: 300 } });
  const h = big.text.match(/\[(r\d+): showing/)[1];
  await g.call("mcp_get_result", { handle: h, fields: ["id", "s"], limit: 2 });
  await g.call("mcp_get_result", { handle: h, fields: ["id", "s"], offset: 2, limit: 2 });
  await g.close();
  await new Promise(r => setTimeout(r, 150));
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["dist/cli.js", "report", "--log", `${g.tmp}/stats.jsonl`], { encoding: "utf-8" });
  assert.match(out, /Turns by kind/);
  assert.match(out, /get_result\s+2 calls/);
  assert.match(out, /testdb\.projections\.mock_compact_list: \["id","s"\]/);
});

test("C3 path that names a per-row field falls back to row mode (found in a live Gemini run)", async t => {
  const g = await startGateway({ gateway: { results: { inlineTokenLimit: 200 } } });
  t.after(g.close);
  const big = await g.call("mcp_call_tool", { tool_name: "testdb__mock_compact_list", arguments: { n: 300 } });
  const h = big.text.match(/\[(r\d+): showing/)[1];
  const counted = await g.call("mcp_get_result", { handle: h, path: "s", grep: "done", count: true });
  assert.match(counted.text, /count: 100 rows matching grep \(of 300\)/);
  const field = await g.call("mcp_get_result", { handle: h, path: "t", limit: 2 });
  assert.match(field.text, /\nt\nitem 0\nitem 1$/);
});
