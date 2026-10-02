import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Universal Meta-Tools exposed to LLM clients (Cursor / Claude Desktop).
 * Replaces dozens of bloated JSON schemas with these 2 lightweight tools (~300 tokens total).
 */
export const MCP_SEARCH_TOOLS: Tool = {
  name: "mcp_search_tools",
  description: "Search downstream tool capabilities using lexical/semantic match. Returns compact TypeScript signatures.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords or intent describing the operation you need (e.g. 'search git issues', 'query postgres users')."
      },
      max_results: {
        type: "number",
        description: "Maximum number of matching tool signatures to return (default: 5)."
      }
    },
    required: ["query"]
  }
};

export const MCP_CALL_TOOL: Tool = {
  name: "mcp_call_tool",
  description: "Execute any discovered downstream tool with optional response projection mask.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description: "The namespaced tool identifier discovered via mcp_search_tools (e.g. 'github::create_issue')."
      },
      arguments: {
        type: "object",
        description: "The parameter map matching the tool's compact TypeScript signature."
      },
      project_fields: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of field paths (e.g. ['id', 'status.name']) to project, eliminating token bloat."
      }
    },
    required: ["tool_name", "arguments"]
  }
};
