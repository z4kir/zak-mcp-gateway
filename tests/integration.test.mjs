import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GatewayServer, GatewayConfigSchema, estimateTokens } from "../dist/index.js";

const mockServerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-server.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zak-gw-"));

async function startGateway(gatewayOverrides = {}, options = {}) {
  const config = {
    ...GatewayConfigSchema.parse({
      gateway: { stats: { logFile: "stats.jsonl" }, ...gatewayOverrides },
      mcpServers: { testdb: { command: "node", args: [mockServerPath], projections: {} } }
    }),
    configDir: tmp
  };
  const gateway = new GatewayServer(config, options);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverT);
  const client = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientT);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: r.content.map(c => c.text).join("\n") };
  };
  return { gateway, client, call, close: async () => { await client.close(); await gateway.close(); } };
}

test("gateway over MCP: tools/list, search, call, cache, confirm, handles, stats", async t => {
  const { client, call, close, gateway } = await startGateway({ results: { inlineTokenLimit: 400, previewRows: 5 } });
  t.after(close);

  // tools/list: only meta-tools, small, plus a name catalog in instructions
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name), ["mcp_search_tools", "mcp_call_tool", "mcp_get_result"]);
  const listTokens = estimateTokens(JSON.stringify({ tools })) + estimateTokens(client.getInstructions() ?? "");
  assert.ok(listTokens < 580, `client sees ${listTokens} tokens of tool definitions`);
  assert.match(client.getInstructions(), /testdb \(prefix testdb__\): mock_read_db, mock_write_db/);

  // search returns compact signatures
  const search = await call("mcp_search_tools", { query: "read database rows" });
  assert.match(search.text, /^\/\/ \[testdb\] Reads rows from the mock database\ntestdb__mock_read_db\(\{/);

  // call: compact TSV, noise keys (avatar_url, node_id) gone, nulls/empties pruned
  const r1 = await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "users" } });
  assert.ok(!r1.isError);
  assert.match(r1.text, /^id\tname\temail\tunused_field\tprofile\.team\twritten\n1\tUser 1/);
  assert.ok(!r1.text.includes("avatar_url"));

  // tolerant name + arg repair (per_page -> perPage) + projection
  const r2 = await call("mcp_call_tool", { tool_name: "testdb::mock_read_db", arguments: { table: "users", per_page: 3 }, project_fields: ["name"] });
  assert.match(r2.text, /renamed "per_page" to "perPage"/);
  assert.match(r2.text, /name\nUser 1\nUser 2\nUser 3/);

  // exact-match cache: identical read does not reach the server again
  const before = JSON.parse((await call("mcp_call_tool", { tool_name: "testdb__mock_read_calls", arguments: { n: 1 } })).text).readCalls;
  await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "users" } });
  const after = JSON.parse((await call("mcp_call_tool", { tool_name: "testdb__mock_read_calls", arguments: { n: 2 } })).text).readCalls;
  assert.equal(after, before, "second identical read served from cache");

  // writes need confirm; a confirmed write invalidates cached reads of that server
  const w1 = await call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "users", data: { a: 1 } } });
  assert.equal(w1.isError, true);
  assert.match(w1.text, /Confirm with the user/);
  const w2 = await call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "users", data: { a: 1 } }, confirm: true });
  assert.ok(!w2.isError);
  const fresh = await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "users" } });
  assert.match(fresh.text, /\t1\n/, "read after write sees the new state, not the cached one");

  // bad args -> signature comes back with the error
  const bad = await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: {} });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /missing required "table"[\s\S]*testdb__mock_read_db\(/);

  // unknown tool -> suggestions
  const unknown = await call("mcp_call_tool", { tool_name: "read_db", arguments: {} });
  assert.match(unknown.text, /Did you mean: testdb__mock_read_db/);

  // big result -> preview + handle; mcp_get_result greps the full data
  const big = await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "users", perPage: 300 } });
  const handle = big.text.match(/\[(r\d+): showing (\d+) of 300 rows/);
  assert.ok(handle, big.text.slice(-200));
  const page = await call("mcp_get_result", { handle: handle[1], grep: "User 299", fields: ["id", "email"] });
  assert.match(page.text, /1 match grep\]\n\[\{"id":299,"email":"user299@example.com"\}\]$/);

  // long plain text -> line preview + grep in raw text
  const logRes = await call("mcp_call_tool", { tool_name: "testdb__mock_read_log", arguments: {} });
  const logHandle = logRes.text.match(/\[(r\d+): showing lines 1-\d+ of 3000/)[1];
  const errors = await call("mcp_get_result", { handle: logHandle, grep: "status=500", limit: 2 });
  assert.match(errors.text, /31 lines match grep[\s\S]*1: 1 INFO request handled path=\/api\/v1\/item\/0 status=500/);

  // untrusted text is flagged
  const note = await call("mcp_call_tool", { tool_name: "testdb__mock_get_note", arguments: { id: "1" } });
  assert.match(note.text, /^\[gateway warning/);

  // stats resource + JSONL log
  const res = await client.readResource({ uri: "zak://stats" });
  const summary = JSON.parse(res.contents[0].text);
  assert.ok(summary.calls >= 10);
  assert.ok(summary.savedTokens > 0, JSON.stringify(summary));
  assert.equal(gateway.stats.summary().session, summary.session);
});

test("safety: global read-only blocks writes; deny list hides tools from search and call", async t => {
  const { call, close } = await startGateway({ safety: { readOnly: true, deny: ["*__mock_get_note"] } });
  t.after(close);
  const w = await call("mcp_call_tool", { tool_name: "testdb__mock_write_db", arguments: { table: "t", data: {} }, confirm: true });
  assert.match(w.text, /read-only mode/);
  const s = await call("mcp_search_tools", { query: "note untrusted user" });
  assert.ok(!s.text.includes("mock_get_note"));
  const c = await call("mcp_call_tool", { tool_name: "testdb__mock_get_note", arguments: { id: "1" } });
  assert.equal(c.isError, true);
});

test("session token budget: tightens, then stops", async t => {
  const { call, close } = await startGateway({ stats: { logFile: "stats.jsonl", sessionTokenBudget: 40 } });
  t.after(close);
  await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "a", perPage: 5 } });
  const stopped = await call("mcp_call_tool", { tool_name: "testdb__mock_read_db", arguments: { table: "b" } });
  assert.equal(stopped.isError, true);
  assert.match(stopped.text, /budget exhausted/);
});

test("code mode: several calls inside the gateway, only the answer returns", async t => {
  const { client, call, close } = await startGateway({ codeMode: { enabled: true } });
  t.after(close);
  assert.ok((await client.listTools()).tools.some(x => x.name === "mcp_run_code"));
  const r = await call("mcp_run_code", {
    code: "const rows = await call('testdb__mock_read_db', {table:'u', perPage: 50}); console.log('rows', rows.length); return rows.filter(r => r.id % 10 === 0).map(r => r.email);"
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^\["user10@example.com","user20@example.com","user30@example.com","user40@example.com","user50@example.com"\]/);
  assert.match(r.text, /\[logs\]\nrows 50/);
  const w = await call("mcp_run_code", { code: "return await call('testdb__mock_write_db', {table:'u', data:{}})" });
  assert.equal(w.isError, true, "writes are refused inside code mode");
});

test("passthrough baseline exposes raw schemas and raw results", async t => {
  const { client, call, close } = await startGateway({}, { passthrough: true });
  t.after(close);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  assert.ok(tools[0].inputSchema.$schema, "schemas are untouched");
  const r = await call("testdb__mock_read_db", { table: "users" });
  assert.match(r.text, /"avatar_url"/);
});
