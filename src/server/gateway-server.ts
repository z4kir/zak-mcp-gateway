import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ValidatedGatewayConfig } from "../config/schema.js";
import { DownstreamClientPool } from "../downstream/client-pool.js";
import { ToolDiscoveryEngine } from "../discovery/search-index.js";
import { ExactMatchShaCache } from "../gate/sha-cache.js";
import { ExecutionDispatcher } from "../execution/dispatcher.js";
import { MCP_SEARCH_TOOLS, MCP_CALL_TOOL } from "./meta-tools.js";

/**
 * TO-MCP Gateway Server:
 * Exposes a standard MCP server to Claude Desktop, Cursor, or any MCP client,
 * multiplexing requests across downstream servers while optimizing token consumption.
 */
export class GatewayServer {
  private server: Server;
  private clientPool: DownstreamClientPool;
  private discoveryEngine: ToolDiscoveryEngine;
  private cache: ExactMatchShaCache;
  private dispatcher: ExecutionDispatcher;

  constructor(private config: ValidatedGatewayConfig) {
    this.server = new Server(
      {
        name: config.gateway.name,
        version: config.gateway.version
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.clientPool = new DownstreamClientPool();
    this.discoveryEngine = new ToolDiscoveryEngine();
    this.cache = new ExactMatchShaCache(
      (config.gateway.cache?.exactMatchTtlSeconds || 300) * 1000
    );
    this.dispatcher = new ExecutionDispatcher(this.clientPool, this.cache);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Expose only the 2 meta-tools (plus pinned tools if configured)
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const pinnedTools = this.discoveryEngine
        .getAllTools()
        .filter(t => t.isPinned)
        .map(t => ({
          name: t.namespacedName,
          description: t.description,
          inputSchema: t.inputSchema
        }));

      return {
        tools: [MCP_SEARCH_TOOLS, MCP_CALL_TOOL, ...pinnedTools]
      };
    });

    // Handle tool invocations
    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;

      if (name === "mcp_search_tools") {
        const query = String(args?.query || "");
        const maxResults = typeof args?.max_results === "number" ? args.max_results : 5;
        const matches = this.discoveryEngine.search(query, maxResults);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query,
                match_count: matches.length,
                tools: matches.map(m => m.signatureText)
              }, null, 2)
            }
          ]
        };
      }

      if (name === "mcp_call_tool") {
        const toolName = String(args?.tool_name || "");
        const toolArgs = (args?.arguments as Record<string, unknown>) || {};
        const projectFields = args?.project_fields as string[] | undefined;

        const result = await this.dispatcher.executeTool({
          tool_name: toolName,
          arguments: toolArgs,
          project_fields: projectFields
        });

        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      // Fallback for pinned direct tool execution
      const result = await this.dispatcher.executeTool({
        tool_name: name,
        arguments: (args as Record<string, unknown>) || {}
      });

      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    });
  }

  public async start(): Promise<void> {
    // 1. Connect and index downstream tools
    const tools = await this.clientPool.initializeServers(this.config.mcpServers);
    this.discoveryEngine.registerTools(tools);

    // 2. Start stdio server for upstream agent host
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
