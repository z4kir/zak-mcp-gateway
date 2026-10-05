/**
 * Tool metadata and descriptor representations within TO-MCP Gateway.
 */

/** A (loose) JSON Schema node as emitted by downstream MCP servers. */
export interface ToolParameterProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: ToolParameterProperty | ToolParameterProperty[];
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  anyOf?: ToolParameterProperty[];
  oneOf?: ToolParameterProperty[];
  allOf?: ToolParameterProperty[];
  $ref?: string;
  [key: string]: unknown;
}

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean | ToolParameterProperty;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** "read" tools are cacheable and allowed in read-only mode; "write" tools are not. */
export type ToolAccess = "read" | "write";

export interface DownstreamTool {
  serverId: string;
  name: string;
  namespacedName: string; // e.g. "github__create_issue"
  description: string;
  inputSchema: ToolInputSchema;
  outputSchema?: ToolInputSchema;
  annotations?: ToolAnnotations;
  access: ToolAccess;
  isPinned?: boolean;
}

export interface CompactToolSignature {
  namespacedName: string;
  signatureText: string;
  /** First sentence of the description, at most ~12 words. */
  summary: string;
  estimatedTokens: number;
}

export interface ToolCallPayload {
  tool_name: string;
  arguments: Record<string, unknown>;
  project_fields?: string[]; // Egress projection mask
  confirm?: boolean; // Explicit confirmation for write tools
  fresh?: boolean; // Skip the cache for this read
  full?: boolean; // Return the full write reply instead of a receipt
}

/** Minimal shape of an MCP CallToolResult that the gateway works with. */
export interface ToolResultContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}
