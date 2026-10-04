import { z } from "zod";

export const DownstreamServerConfigSchema = z.object({
  /** stdio servers */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  /** remote servers (Streamable HTTP, falls back to SSE) */
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  /** Expose this server's tools directly in tools/list (full schema, costs tokens every turn). */
  pinned: z.boolean().default(false),
  /** Block every write tool on this server. */
  readOnly: z.boolean().default(false),
  /** Default projection per tool name, applied when the agent passes no project_fields. */
  projections: z.record(z.array(z.string())).default({}),
  /** Extra key patterns to drop from this server's JSON results (added to results.dropKeys). */
  dropKeys: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().positive().default(60_000)
});

export const GatewayCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  exactMatchTtlSeconds: z.number().positive().default(300),
  maxEntries: z.number().positive().default(1000)
});

export const GatewayDiscoveryConfigSchema = z.object({
  maxSearchResults: z.number().positive().default(5),
  /** Drop matches scoring below this fraction of the best match (0..1). */
  minScore: z.number().min(0).max(1).default(0.2),
  /** Put a one-line-per-server tool name index into the MCP `instructions`. */
  catalogInInstructions: z.boolean().default(true)
});

export const GatewayResultsConfigSchema = z.object({
  /** Results larger than this (estimated tokens) are stored and previewed via a handle. */
  inlineTokenLimit: z.number().positive().default(1500),
  previewRows: z.number().positive().default(10),
  /** Individual strings longer than this are clipped in the inline view. */
  maxStringChars: z.number().positive().default(600),
  /** How many results to keep for mcp_get_result (LRU). */
  maxStored: z.number().positive().default(50),
  /** Render arrays of objects as TSV when that is smaller than JSON. */
  tsv: z.boolean().default(true),
  /** Key patterns dropped from JSON results (glob, matched against the key name). */
  dropKeys: z.array(z.string()).default(["*_url", "node_id", "gravatar_id", "_links"]),
  /** Keys never dropped even if a dropKeys pattern matches. */
  keepKeys: z.array(z.string()).default(["html_url"])
});

export const GatewaySafetyConfigSchema = z.object({
  /** Block every write tool on every server. */
  readOnly: z.boolean().default(false),
  /** Write tools need `confirm: true` on mcp_call_tool. */
  confirmWrites: z.boolean().default(true),
  /** Glob patterns over namespaced tool names. Empty allow list = allow all. Deny wins. */
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  /** Flag tool results that contain instruction-like text (prompt injection). */
  warnOnInjection: z.boolean().default(true)
});

export const GatewayStatsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** JSONL log, relative to the config file's directory. */
  logFile: z.string().default("../.zak-gateway/stats.jsonl"),
  /** Optional per-session budget for tokens returned to the model (0 = off). */
  sessionTokenBudget: z.number().nonnegative().default(0)
});

export const GatewayCodeModeConfigSchema = z.object({
  /** Expose mcp_run_code. NOT a security sandbox: only enable for trusted agents. */
  enabled: z.boolean().default(false),
  timeoutMs: z.number().positive().default(30_000),
  maxToolCalls: z.number().positive().default(25)
});

export const GatewayConfigSchema = z.object({
  gateway: z.object({
    name: z.string().default("zak-mcp-gateway"),
    version: z.string().default("0.2.0"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    cache: GatewayCacheConfigSchema.default({}),
    discovery: GatewayDiscoveryConfigSchema.default({}),
    results: GatewayResultsConfigSchema.default({}),
    safety: GatewaySafetyConfigSchema.default({}),
    stats: GatewayStatsConfigSchema.default({}),
    codeMode: GatewayCodeModeConfigSchema.default({})
  }).passthrough().default({}),
  mcpServers: z.record(DownstreamServerConfigSchema).default({})
}).passthrough();

export type ValidatedGatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type DownstreamServerConfig = z.infer<typeof DownstreamServerConfigSchema>;
export type GatewayResultsConfig = z.infer<typeof GatewayResultsConfigSchema>;
export type GatewaySafetyConfig = z.infer<typeof GatewaySafetyConfigSchema>;
