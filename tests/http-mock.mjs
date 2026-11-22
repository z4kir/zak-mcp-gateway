// A Streamable HTTP MCP server with sessions, for tests. restart() drops every session,
// like a redeploy of a remote server; `calls` counts how often each tool really ran.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export async function startHttpMcp({ auth } = {}) {
  const calls = { list_records: 0, update_record: 0 };
  let transports = new Map();

  const handler = async (req, res) => {
    if (auth && req.headers.authorization !== auth) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("send 'Bearer <token>'");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    const sid = req.headers["mcp-session-id"];
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (sid) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => transports.set(id, t) });
      transport = t;
      const mcp = new McpServer({ name: "http-mock", version: "1.0.0" });
      mcp.registerTool("list_records", { description: "Lists records", inputSchema: {} }, async () => {
        calls.list_records++;
        return { content: [{ type: "text", text: JSON.stringify([{ id: 1, name: "rec" }]) }] };
      });
      mcp.registerTool("update_record", { description: "Updates a record", inputSchema: { id: z.number() } }, async ({ id }) => {
        calls.update_record++;
        return { content: [{ type: "text", text: `updated ${id}` }] };
      });
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  };

  let server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    /** Drop every session and listen again on the same port (a redeploy). */
    async restart() {
      await stop();
      transports = new Map();
      server = http.createServer(handler);
      await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    },
    close: stop
  };
}
