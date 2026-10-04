/**
 * Live end-to-end check through the real CLI over stdio, exactly how Claude Desktop,
 * Cursor or the agent UI start the gateway.
 *
 *   node tests/test-github-live.mjs                       # public repo, no token needed
 *   GITHUB_PERSONAL_ACCESS_TOKEN=... GITHUB_REPO=you/repo node tests/test-github-live.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoSpec = process.env.GITHUB_REPO || "modelcontextprotocol/servers";
const [owner, repo] = repoSpec.split("/");
const text = r => r.content.map(c => c.text).join("\n");

const client = new Client({ name: "github-live-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "cli.js"), "--config", path.join(root, "config", "servers.json")],
    stderr: "inherit"
  })
);

const { tools } = await client.listTools();
console.log(`\n1. tools/list -> ${tools.map(t => t.name).join(", ")}`);
console.log(`   instructions:\n${client.getInstructions()}\n`);

const search = await client.callTool({ name: "mcp_search_tools", arguments: { query: "recent commits", limit: 2 } });
console.log(`2. mcp_search_tools("recent commits"):\n${text(search)}\n`);

// per_page is deliberately "wrong" (the tool wants perPage): the gateway repairs it.
const commits = await client.callTool({
  name: "mcp_call_tool",
  arguments: { tool_name: "github__list_commits", arguments: { owner, repo, per_page: 3 }, project_fields: ["sha", "commit.message", "commit.author.name"] }
});
console.log(`3. mcp_call_tool github__list_commits on ${repoSpec} (projected):\n${text(commits)}\n`);

const write = await client.callTool({
  name: "mcp_call_tool",
  arguments: { tool_name: "github__create_issue", arguments: { owner, repo, title: "should not be created" } }
});
console.log(`4. write without confirm is stopped by the gateway: ${text(write)}\n`);

const stats = await client.readResource({ uri: "zak://stats" });
console.log(`5. zak://stats -> ${stats.contents[0].text}\n`);

await client.close();
const failed = commits.isError || !text(commits).includes("sha") || !write.isError;
console.log(failed ? "FAILED" : "OK: GitHub MCP works through the gateway");
process.exit(failed ? 1 : 0);
