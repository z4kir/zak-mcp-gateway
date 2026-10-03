import { DownstreamClientPool } from "../dist/downstream/client-pool.js";
import { ToolDiscoveryEngine } from "../dist/discovery/search-index.js";
import { ExactMatchShaCache } from "../dist/gate/sha-cache.js";
import { ExecutionDispatcher } from "../dist/execution/dispatcher.js";

async function runLiveTest() {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g., "skzak/zak-mcp-gateway"

  if (!token) {
    console.error("❌ ERROR: Please set GITHUB_PERSONAL_ACCESS_TOKEN environment variable.");
    process.exit(1);
  }
  if (!repo) {
    console.error("❌ ERROR: Please set GITHUB_REPO environment variable (e.g., 'your-username/your-repo').");
    process.exit(1);
  }

  console.log("🚀 Starting ZAK MCP Gateway Live GitHub Test...");

  const clientPool = new DownstreamClientPool();
  const discoveryEngine = new ToolDiscoveryEngine();

  // 1. Configure and connect to official GitHub MCP Server
  const serversConfig = {
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: token }
    }
  };

  console.log("\n📡 Connecting to GitHub MCP Server...");
  const discoveredTools = await clientPool.initializeServers(serversConfig);
  discoveryEngine.registerTools(discoveredTools);
  console.log(`✅ Connected! Discovered ${discoveredTools.length} GitHub tools.`);

  // 2. Test Discovery (mcp_search_tools)
  console.log("\n🔍 Testing JIT Discovery (Searching for 'issues')...");
  const searchResults = discoveryEngine.search("issues");
  console.log(`✅ Found ${searchResults.length} matching tools! Top match:`);
  console.log("--------------------------------------------------");
  console.log(searchResults[0].signatureText);
  console.log("--------------------------------------------------");

  // 3. Test Execution & Egress Projection (mcp_call_tool)
  const cache = new ExactMatchShaCache();
  const dispatcher = new ExecutionDispatcher(clientPool, cache);

  console.log(`\n⚡ Executing Tool: github::list_commits on ${repo}`);
  console.log("✂️  Applying Projection Mask: keeping ONLY 'sha', 'commit.message', and 'commit.author.name'...");

  try {
    const result = await dispatcher.executeTool({
      tool_name: "github::list_commits",
      arguments: {
        owner: repo.split("/")[0],
        repo: repo.split("/")[1],
        per_page: 3 // just fetch the latest 3 commits
      },
      // Egress Projection: Strip away the massive commit metadata!
      project_fields: ["sha", "commit.message", "commit.author.name"] 
    });

    console.log("\n🎉 GATEWAY RESPONSE (Distilled & Cleaned):");
    console.log("--------------------------------------------------");
    console.log(result.content[0].text);
    console.log("--------------------------------------------------");

  } catch (err) {
    console.log("\n⚠️ Tool execution failed");
    console.log(err.message);
  }

  await clientPool.closeAll();
  process.exit(0);
}

runLiveTest();
