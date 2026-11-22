// v0.5: see and recover the servers behind the gateway, and keep a live server safe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { startGateway, mockServerPath } from "./helpers.mjs";

const mock = (env = {}) => ({ command: "node", args: [mockServerPath], env });
const broken = { command: "node", args: ["-e", "process.exit(3)"] };
const tmpFile = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zak-050-")), name);
const status = async g => (await g.call("mcp_status", {})).text;
const readCalls = async (g, server) =>
  JSON.parse((await g.call("mcp_call_tool", { tool_name: `${server}__mock_read_calls`, arguments: { n: Math.random() } })).text).readCalls;

test("v0.5 #1 a server that fails to start is named in the instructions and in mcp_status", async t => {
  const g = await startGateway({ extraServers: { broken } });
  t.after(g.close);
  const tools = (await g.client.listTools()).tools.map(x => x.name);
  assert.ok(tools.includes("mcp_status"), "mcp_status is listed");
  assert.match(g.gateway.getInstructions(), /Not connected: broken \(.+\)\. mcp_status shows details and can reconnect\./);
  const s = await status(g);
  assert.match(s, /^server\s+state\s+tools\s+note/m);
  assert.match(s, /^testdb\s+ok\s+8\b/m);
  assert.match(s, /^broken\s+FAILED\s+-\s+.*Connection closed/m);
});

test("v0.5 #1 a call to a server that is down says why and how to retry", async t => {
  const g = await startGateway({ extraServers: { broken } });
  t.after(g.close);
  const r = await g.call("mcp_call_tool", { tool_name: "broken__anything", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Server "broken" is not connected \(failed: .*Connection closed.*\)\. mcp_status \{"reconnect": "broken"\} retries now\.$/);
});

test("v0.5 #3 a failed server comes back on the next call to it, or with mcp_status reconnect", async t => {
  const up1 = tmpFile("up1");
  const up2 = tmpFile("up2");
  const g = await startGateway({
    gateway: { status: { retryAfterMs: 0 } },
    extraServers: { flaky: mock({ MOCK_FAIL_UNLESS_FILE: up1 }), flaky2: mock({ MOCK_FAIL_UNLESS_FILE: up2 }) }
  });
  t.after(g.close);
  assert.match(await status(g), /^flaky\s+FAILED/m);

  fs.writeFileSync(up1, "up");
  const r = await g.call("mcp_call_tool", { tool_name: "flaky__mock_read_db", arguments: { table: "u", perPage: 1 } });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /User 1/, "the call reconnected the server, then ran");
  assert.match(await status(g), /^flaky\s+ok\s+8\b/m);

  fs.writeFileSync(up2, "up");
  const re = await g.call("mcp_status", { reconnect: "all" });
  assert.match(re.text, /^flaky2\s+ok\s+8\b/m);
  assert.match(re.text, /Reconnect: flaky2 ok$/m);
  const s = await g.call("mcp_search_tools", { query: "read rows from the mock database", limit: 10 });
  assert.match(s.text, /flaky2__mock_read_db/, "its tools are searchable after the reconnect");
});

test("v0.5 #3 a dropped connection is marked disconnected and the next call reconnects", async t => {
  const g = await startGateway({ gateway: { status: { retryAfterMs: 0 } }, extraServers: { dropper: mock({ MOCK_EXIT_AFTER_MS: "1500" }) } });
  t.after(g.close);
  await new Promise(r => setTimeout(r, 2500));
  assert.match(await status(g), /^dropper\s+DISCONNECTED\s+-\s+.*the connection closed$/m);
  const r = await g.call("mcp_call_tool", { tool_name: "dropper__mock_read_db", arguments: { table: "u", perPage: 1 } });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /User 1/);
});

test("v0.5 #4 confirmWrites per server: local writes run, the live server asks first", async t => {
  const g = await startGateway({ gateway: { safety: { confirmWrites: false } }, extraServers: { live: { ...mock(), confirmWrites: true } } });
  t.after(g.close);
  const local = await g.call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "a", data: { v: 1 } } });
  assert.ok(!local.isError, local.text);
  const live = await g.call("mcp_call_tool", { tool_name: "live__mock_write_db", arguments: { table: "a", data: { v: 1 } } });
  assert.equal(live.isError, true);
  assert.match(live.text, /"live__mock_write_db" changes data\. Confirm with the user/);
  const ok = await g.call("mcp_call_tool", { tool_name: "live__mock_write_db", arguments: { table: "a", data: { v: 1 } }, confirm: true });
  assert.ok(!ok.isError, ok.text);
  const s = await status(g);
  assert.match(s, /^live\s+ok\s+8\s+writes need confirm; full names only$/m);
  assert.match(s, /^testdb\s+ok\s+8$/m, "the local server needs no confirmation");
});

test("v0.5 #5 a bare tool name never reaches a protected server, even when the local copy is down", async t => {
  const g = await startGateway({ extraServers: { live: { ...mock(), confirmWrites: true } } });
  t.after(g.close);
  assert.equal(g.gateway.pool.resolveTool("mock_read_db")?.serverId, "testdb", "a bare name goes to the unprotected copy");
  assert.equal(g.gateway.pool.resolveTool("Mock_Read_DB")?.serverId, "testdb", "so does a fuzzy one");
  assert.equal(g.gateway.pool.resolveTool("live__mock_read_db")?.serverId, "live", "the full name still works");

  const down = await startGateway({ server: broken, extraServers: { live: { ...mock(), confirmWrites: true } } });
  t.after(down.close);
  assert.equal(down.gateway.pool.resolveTool("mock_read_db"), undefined, "local copy down: no silent switch to the live server");
  const before = await readCalls(down, "live");
  const r = await down.call("mcp_call_tool", { tool_name: "mock_read_db", arguments: { table: "u" } });
  assert.equal(r.isError, true);
  assert.match(r.text, /Tool "mock_read_db" not found/);
  assert.equal(await readCalls(down, "live"), before, "the live server was not called");
});

test("v0.5 #6 a server label shows in the catalog, in search hits and in mcp_status", async t => {
  const g = await startGateway({ server: { label: "LIVE, production" } });
  t.after(g.close);
  assert.match(g.gateway.getInstructions(), /testdb \[LIVE, production\] \(prefix testdb__\)/);
  const s = await g.call("mcp_search_tools", { query: "read rows from the mock database" });
  assert.match(s.text, /\/\/ \[testdb · LIVE, production\]/);
  assert.match(await status(g), /^testdb\s+ok\s+8\s+LIVE, production; writes need confirm$/m);
});

test("v0.5 #7 HTTP 401: the server's own reason is kept, SSE is not tried, the key is not shown", async t => {
  let gets = 0;
  const key = "key_abcdef1234567890";
  const srv = http.createServer((req, res) => {
    if (req.method === "GET") gets++;
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`invalid key ${req.headers.authorization}; send 'Bearer <key>'`);
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const g = await startGateway({ extraServers: { remote: { url, headers: { Authorization: key } } } });
  t.after(g.close);
  const s = await status(g);
  assert.match(s, /^remote\s+FAILED\s+-\s+.*HTTP 401 Unauthorized: invalid key \*\*\*; send 'Bearer <key>'/m);
  assert.ok(!s.includes(key), "the key is redacted");
  assert.ok(!g.gateway.getInstructions().includes(key), "also in the instructions");
  assert.doesNotMatch(s, /SSE/);
  assert.equal(gets, 0, "no SSE fallback after a 401");
  assert.match(g.gateway.getInstructions(), /Not connected: remote \(HTTP 401 Unauthorized/);
});

test("v0.5 #2 the status prompt and the zak://servers resource show every server", async t => {
  const g = await startGateway({ extraServers: { broken } });
  t.after(g.close);
  const { prompts } = await g.client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name), ["status"]);
  const p = await g.client.getPrompt({ name: "status" });
  assert.match(p.messages[0].content.text, /^broken\s+FAILED/m);
  assert.match(p.messages[0].content.text, /The gateway has a tool whose name ends in mcp_status .*{"reconnect": "<server>"}/);
  const res = await g.client.readResource({ uri: "zak://servers" });
  const rows = JSON.parse(res.contents[0].text);
  assert.deepEqual(rows.map(r => [r.serverId, r.state]), [["testdb", "ok"], ["broken", "failed"]]);
});

test("v0.5 #2 status file, the status command and its one-line form", async t => {
  const g = await startGateway({ extraServers: { broken } });
  t.after(g.close);
  await g.gateway.whenDownstreamReady();
  await new Promise(r => setTimeout(r, 300));
  const body = JSON.parse(fs.readFileSync(path.join(g.tmp, "status.json"), "utf-8"));
  assert.equal(body.pid, process.pid);
  assert.deepEqual(body.servers.map(s => [s.id, s.state]), [["testdb", "ok"], ["broken", "failed"]]);

  const cfg = path.join(g.tmp, "servers.json");
  fs.writeFileSync(cfg, JSON.stringify({ gateway: { stats: { logFile: "stats.jsonl" } }, mcpServers: {} }));
  const table = spawnSync(process.execPath, ["dist/cli.js", "status", "--config", cfg], { encoding: "utf-8" });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /pid \d+: running/);
  assert.match(table.stdout, /^broken\s+FAILED/m);
  const line = spawnSync(process.execPath, ["dist/cli.js", "status", "--config", cfg, "--line"], { encoding: "utf-8" });
  assert.equal(line.stdout.trim(), "MCP testdb ✓  broken ✗");
});

test("v0.5 check shows labels and does not touch the status file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zak-050-check-"));
  const cfg = path.join(dir, "servers.json");
  fs.writeFileSync(cfg, JSON.stringify({
    gateway: { stats: { enabled: false, logFile: "stats.jsonl" } },
    mcpServers: { testdb: { command: "node", args: [mockServerPath], label: "LIVE" } }
  }));
  const out = spawnSync(process.execPath, ["dist/cli.js", "check", "--config", cfg], { encoding: "utf-8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /testdb\s+ok, 8 tools\s+\[LIVE\]/);
  assert.equal(fs.existsSync(path.join(dir, "status.json")), false);
});

test("v0.5 #3 a remote server that restarts: a read reconnects on a fresh session, a write never runs twice", async t => {
  const { startHttpMcp } = await import("./http-mock.mjs");
  const remote = await startHttpMcp();
  t.after(remote.close);
  const g = await startGateway({ gateway: { status: { retryAfterMs: 0 } }, extraServers: { remote: { url: remote.url } } });
  t.after(g.close);

  const first = await g.call("mcp_call_tool", { tool_name: "remote__list_records", arguments: {}, fresh: true });
  assert.ok(!first.isError, first.text);
  assert.equal(remote.calls.list_records, 1);

  await remote.restart();
  const again = await g.call("mcp_call_tool", { tool_name: "remote__list_records", arguments: {}, fresh: true });
  assert.ok(!again.isError, again.text);
  assert.match(again.text, /rec/);
  assert.equal(remote.calls.list_records, 2, "the read ran once, on the new session");
  assert.match(await status(g), /^remote\s+ok\s+2\b/m);

  await remote.restart();
  const write = args => g.call("mcp_call_tool", { tool_name: "remote__update_record", arguments: args, confirm: true });
  let w = await write({ id: 7 });
  if (w.isError) {
    assert.match(w.text, /The connection to "remote" was lost (before the request arrived, so this change did not run|during the call, so this change may or may not have run: check before repeating it). The next call reconnects./, w.text);
    w = await write({ id: 7 });
  }
  assert.ok(!w.isError, w.text);
  assert.match(w.text, /updated 7/);
  assert.equal(remote.calls.update_record, 1, "the write ran exactly once");
});
