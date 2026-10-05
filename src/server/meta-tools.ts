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
      limit: { type: "number" },
      detail: { type: "string", description: "\"full\" = signatures for every hit" }
    },
    required: ["query"]
  }
};

export const MCP_CALL_TOOL: Tool = {
  name: "mcp_call_tool",
  description: "Call a tool by name, or several via calls. Big results return a preview + handle.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "e.g. github__list_commits" },
      arguments: { type: "object", description: "a value may be {\"$ref\":\"r3\",\"path\"?,\"replace\"?} to reuse stored data" },
      project_fields: {
        type: "array",
        items: { type: "string" },
        description: "Field paths to keep, e.g. [\"sha\",\"commit.message\"]"
      },
      confirm: { type: "boolean", description: "true only after the user approved a write" },
      calls: {
        type: "array",
        description: "[{tool_name, arguments}] run in order",
        items: { type: "object" }
      }
    }
  }
};

export const MCP_GET_RESULT: Tool = {
  name: "mcp_get_result",
  description: "Use a stored result by handle: page, grep (regex), fields, raw, path (one field in full); or count/group_by/distinct/sort (\"-x\" = desc).",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      grep: { type: "string" },
      fields: { type: "array", items: { type: "string" } },
      raw: { type: "boolean" },
      count: { type: "boolean" },
      group_by: { type: "string" },
      distinct: { type: "string" },
      sort: { type: "string" },
      path: { type: "string" }
    },
    required: ["handle"]
  }
};

export const MCP_RUN_CODE: Tool = {
  name: "mcp_run_code",
  description: "Run an async JavaScript function body in a sandbox. `await call(toolName, args)` returns parsed JSON (read tools only); only your return value comes back.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "e.g. const c = await call('github__list_commits', {owner:'o', repo:'r'}); return c.length;" }
    },
    required: ["code"]
  }
};

export const MCP_GET_SKILL: Tool = {
  name: "mcp_get_skill",
  description: "Load the full instructions of a skill listed in the server instructions.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
  }
};
