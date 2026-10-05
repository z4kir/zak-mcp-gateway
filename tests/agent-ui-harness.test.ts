import test from "node:test";
import assert from "node:assert/strict";
import { trimHistory, unverifiedValues } from "../agent-ui/app/api/chat/harness";

test("D3 trimHistory shortens only long old tool results and keeps the handle", () => {
  const long = "id\tname\n" + "1\tUser\n".repeat(200) + "[r7: showing 10 of 200 rows]";
  const history = [
    { role: "user", parts: [{ text: "list users" }] },
    { role: "model", parts: [{ functionCall: { name: "mcp_call_tool", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "mcp_call_tool", response: { output: long } } }] },
    { role: "user", parts: [{ functionResponse: { name: "mcp_call_tool", response: { output: "short" } } }] }
  ];
  const { history: out, trimmed } = trimHistory(history);
  assert.equal(trimmed, 1);
  const output = (out[2].parts![0].functionResponse!.response as { output: string }).output;
  assert.ok(output.length < 400);
  assert.match(output, /trimmed old result; full data: mcp_get_result handle r7\]$/);
  assert.equal((out[3].parts![0].functionResponse!.response as { output: string }).output, "short");
  assert.equal(out[1].parts![0].functionCall!.name, "mcp_call_tool", "model turns untouched");
});

test("D3 verifier flags SHAs, ids and numbers missing from tool results", () => {
  const evidence = "sha\tmessage\n5abed86c5317b833dd59907492d56c65981642aa\tfix\nissue 4958 INC0012345";
  const ok = unverifiedValues("Latest commit 5abed86 fixes #4958 (INC0012345).", evidence);
  assert.deepEqual(ok, []);
  const bad = unverifiedValues("Commit 9f9f9f9a and #1234 and INC0099999 and 1234567.", evidence);
  assert.deepEqual(bad.sort(), ["1234", "1234567", "9f9f9f9a", "INC0099999"].sort());
  assert.deepEqual(unverifiedValues("Done in 2026, 3 items.", evidence), [], "years and small numbers are not checked");
});
