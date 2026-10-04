import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Meta-tools exposed to LLM clients instead of every downstream schema.
 * Descriptions are deliberately short: they are paid for on every model request.
 */
export const MCP_SEARCH_TOOLS: Tool = {
  name: "mcp_search_tools",
  description: "Find tools on the connected MCP servers. Returns signatures for mcp_call_tool.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you want to do" },
      limit: { type: "number" }
    },
    required: ["query"]
  }
};

export const MCP_CALL_TOOL: Tool = {
  name: "mcp_call_tool",
  description: "Call a tool by name. Big results return a preview and a handle for mcp_get_result.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "e.g. github__list_commits" },
      arguments: { type: "object" },
      project_fields: {
        type: "array",
        items: { type: "string" },
        description: "Field paths to keep, e.g. [\"sha\",\"commit.message\"]"
      },
      confirm: { type: "boolean", description: "true only after the user approved a write" }
    },
    required: ["tool_name", "arguments"]
  }
};

export const MCP_GET_RESULT: Tool = {
  name: "mcp_get_result",
  description: "Read a stored result by handle: page (offset, limit), filter rows (grep regex), pick fields, or raw:true.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      grep: { type: "string" },
      fields: { type: "array", items: { type: "string" } },
      raw: { type: "boolean" }
    },
    required: ["handle"]
  }
};

export const MCP_RUN_CODE: Tool = {
  name: "mcp_run_code",
  description: "Run an async JavaScript function body inside the gateway. Use `await call(toolName, args)` (returns parsed JSON) to combine several read-only tool calls; only your return value comes back.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "e.g. const c = await call('github__list_commits', {owner:'o', repo:'r'}); return c.length;" }
    },
    required: ["code"]
  }
};
