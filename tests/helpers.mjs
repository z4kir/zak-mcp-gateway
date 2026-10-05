import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GatewayServer, GatewayConfigSchema } from "../dist/index.js";

export const mockServerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-server.mjs");

/**
 * Start a gateway in-process in front of the mock MCP server and connect a real MCP client.
 * `server` overrides the downstream server config; `clientCapabilities` / `clientHandlers`
 * let a test act as an agent host that supports elicitation or sampling.
 */
export async function startGateway({ gateway = {}, server = {}, extraServers = {}, options = {}, clientCapabilities = {}, setupClient } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zak-gw-"));
  const config = {
    ...GatewayConfigSchema.parse({
      gateway: { stats: { logFile: "stats.jsonl" }, ...gateway },
      mcpServers: { testdb: { command: "node", args: [mockServerPath], ...server }, ...extraServers }
    }),
    configDir: tmp
  };
  const gw = new GatewayServer(config, options);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: clientCapabilities });
  if (setupClient) setupClient(client);
  await gw.initialize();
  await Promise.all([gw.connect(serverT), client.connect(clientT)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: r.content.map(c => c.text).join("\n") };
  };
  return {
    gateway: gw,
    client,
    call,
    tmp,
    close: async () => {
      await client.close();
      await gw.close();
    }
  };
}
