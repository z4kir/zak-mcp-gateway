/**
 * Tool metadata and descriptor representations within TO-MCP Gateway.
 */

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface DownstreamTool {
  serverId: string;
  name: string;
  namespacedName: string; // e.g. "github::create_issue"
  description: string;
  inputSchema: ToolInputSchema;
  isPinned?: boolean;
  isIdempotent?: boolean;
}

export interface CompactToolSignature {
  namespacedName: string;
  signatureText: string;
  estimatedTokens: number;
}

export interface SearchToolsResult {
  tools: CompactToolSignature[];
  totalMatches: number;
}

export interface ToolCallPayload {
  tool_name: string;
  arguments: Record<string, unknown>;
  project_fields?: string[]; // Egress projection mask
}
