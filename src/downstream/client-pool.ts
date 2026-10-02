import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DownstreamServerConfig } from "../types/gateway.js";
import { DownstreamTool, ToolInputSchema } from "../types/tool.js";

/**
 * Downstream Client Pool:
 * Supervises connections to multiple upstream/downstream MCP servers (GitHub, Postgres, FS, etc.)
 */
export class DownstreamClientPool {
  private clients = new Map<string, Client>();
  private tools = new Map<string, DownstreamTool>();

  /**
   * Connect to all configured downstream MCP servers.
   */
  public async initializeServers(servers: Record<string, DownstreamServerConfig>): Promise<DownstreamTool[]> {
    const discoveredTools: DownstreamTool[] = [];

    for (const [serverId, config] of Object.entries(servers)) {
      if (!config.command) continue;

      try {
        const mergedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") mergedEnv[k] = v;
        }
        if (config.env) {
          Object.assign(mergedEnv, config.env);
        }

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: mergedEnv
        });

        const client = new Client(
          { name: `gateway-client-${serverId}`, version: "0.1.0" },
          { capabilities: {} }
        );

        await client.connect(transport);
        this.clients.set(serverId, client);

        // Fetch tool list from this server
        const toolsResponse = await client.listTools();
        for (const tool of toolsResponse.tools) {
          const namespaced = `${serverId}::${tool.name}`;
          const downstreamTool: DownstreamTool = {
            serverId,
            name: tool.name,
            namespacedName: namespaced,
            description: tool.description || "",
            inputSchema: tool.inputSchema as ToolInputSchema,
            isPinned: config.pinned || false,
            isIdempotent: config.readOnly || false
          };

          this.tools.set(namespaced, downstreamTool);
          discoveredTools.push(downstreamTool);
        }
      } catch (err) {
        console.error(`[Gateway] Failed to connect to downstream server "${serverId}":`, err);
      }
    }

    return discoveredTools;
  }

  public getClient(serverId: string): Client | undefined {
    return this.clients.get(serverId);
  }

  public getTool(namespacedName: string): DownstreamTool | undefined {
    return this.tools.get(namespacedName);
  }

  public async closeAll(): Promise<void> {
    for (const [id, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch (err) {
        console.error(`[Gateway] Error closing server ${id}:`, err);
      }
    }
    this.clients.clear();
  }
}
