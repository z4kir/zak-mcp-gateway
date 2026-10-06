import { z } from "zod";

/** Per-server overrides for result handling (idea: per-server result limits). */
export const ServerResultsConfigSchema = z.object({
  inlineTokenLimit: z.number().positive().optional(),
  maxStringChars: z.number().positive().optional(),
  /**
   * full  = projection, noise keys, nulls, TSV, clipping, handles (raw-JSON servers)
   * light = projection + compact JSON only; a handle only when over the limit (compact servers)
   * off   = pass results through untouched
   */
  distill: z.enum(["full", "light", "off"]).default("full"),
  /** Reply to successful writes with {ok, id...} and keep the full echo behind a handle. */
  writeReceipts: z.boolean().optional()
});

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
  results: ServerResultsConfigSchema.default({}),
  /** Extra search synonyms for this server's vocabulary, e.g. { "ticket": ["incident"] }. */
  synonyms: z.record(z.array(z.string())).default({}),
  /** Append this server's own MCP instructions to the gateway's instructions (capped). */
  forwardInstructions: z.boolean().default(true),
  /**
   * Arguments injected when the agent omits them, per tool, e.g. page size or server-side
   * field selection: { "list_records": { "limit": 20, "fields": "id,name" } }.
   */
  defaultArgs: z.record(z.record(z.unknown())).default({}),
  /** Override read/write classification per tool name. */
  access: z.record(z.enum(["read", "write"])).default({}),
  /** Treat a read tool as a write when its arguments match, e.g. { "fetch_page": { "save": true } }. */
  writeIf: z.record(z.record(z.unknown())).default({}),
  /** Exact-match cache for this server's read tools. */
  cache: z.boolean().default(true),
  cacheTtlSeconds: z.number().positive().optional(),
  /** Servers sharing a backend: a write on any of them clears the cache of all. */
  cacheGroup: z.string().optional(),
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
  /** Legacy switch; `catalog` wins when set. */
  catalogInInstructions: z.boolean().default(true),
  /**
   * Tool index in the instructions:
   * names = every tool name · groups = tool families per server · servers = server list · off
   */
  catalog: z.enum(["names", "groups", "servers", "off"]).optional(),
  /** How many search hits get a full signature; the rest are name + short summary. */
  fullSignatures: z.number().int().nonnegative().default(1),
  /** Put one-line signatures of the N most-used tools (from the stats log) in the instructions. */
  hotSignatures: z.number().int().nonnegative().default(0),
  /** Max characters of each downstream server's own instructions to forward (0 = none). */
  serverInstructionsMaxChars: z.number().int().nonnegative().default(600),
  /**
   * Tools whose one-line signatures always go into the instructions, so the agent can call
   * them without searching (globs over namespaced names, e.g. "lean__ap_create_*").
   */
  pinnedSignatures: z.array(z.string()).default([]),
  /** "slim" meta-tools: shorter descriptions, no parameter notes (fewer tokens every turn). */
  metaToolStyle: z.enum(["standard", "slim"]).default("standard"),
  /** Full search hits as multi-line signatures with parameter notes, or one line each. */
  signatureStyle: z.enum(["full", "oneline"]).default("full"),
  /** The other search hits as "name: summary" or just the name. */
  alsoStyle: z.enum(["summary", "name"]).default("summary")
});

/** A step of a workflow: one tool call, optionally repeated for each item of a list. */
export const WorkflowStepSchema = z.object({
  /** Name used to refer to this step's result: ${steps.<id>.path}. */
  id: z.string().optional(),
  /** Namespaced tool name, e.g. "github__list_issues". */
  tool: z.string(),
  /** Arguments; strings may contain ${input.x}, ${steps.id.path} or ${item.x}. */
  arguments: z.record(z.unknown()).default({}),
  /** Run once per element of this list, e.g. "${input.columns}"; the element is ${item}. */
  forEach: z.string().optional(),
  /** Fields of this step's result to show in the summary (paths). */
  report: z.array(z.string()).default([]),
  /**
   * Fields kept when ${steps.<id>} is used in the workflow output (default: the server's
   * projection for that tool). Arguments always see the full result.
   */
  fields: z.array(z.string()).optional()
});

export const WorkflowSchema = z.object({
  /** When to use it, and when not to. Shown to the agent. */
  description: z.string(),
  /** Inputs the agent provides (JSON Schema properties). */
  input: z.object({
    properties: z.record(z.unknown()).default({}),
    required: z.array(z.string()).default([])
  }).default({}),
  steps: z.array(WorkflowStepSchema).min(1),
  /** Optional final summary values, e.g. { "table": "${steps.table.name}" }. */
  output: z.record(z.unknown()).optional()
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
  keepKeys: z.array(z.string()).default(["html_url"]),
  /** Default for write receipts (servers can override). */
  writeReceipts: z.boolean().default(false),
  /** Keys copied into a write receipt when present. */
  receiptKeys: z.array(z.string()).default(["id", "uuid", "sys_id", "number", "key", "sha", "name", "html_url", "url", "status", "state"]),
  /** Reply "same as rN" when a result is byte-identical to a stored one. */
  dedupe: z.boolean().default(false)
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
  /** Expose mcp_run_code (read tools only). */
  enabled: z.boolean().default(false),
  /** process = separate Node process with the permission model (default); vm = in-process, trusted use only. */
  isolation: z.enum(["process", "vm"]).default("process"),
  timeoutMs: z.number().positive().default(30_000),
  maxToolCalls: z.number().positive().default(25),
  memoryMb: z.number().positive().default(64)
});

export const GatewayKnowledgeConfigSchema = z.object({
  /** Rules text sent in the instructions of every session. */
  rules: z.string().optional(),
  /** File with rules (relative to the config file). */
  rulesFile: z.string().optional(),
  /** Folder of skills: <name>/SKILL.md or <name>.md, optional front matter name/description. */
  skillsDir: z.string().optional(),
  maxRulesChars: z.number().positive().default(6000)
});

export const GatewayClientFeaturesSchema = z.object({
  /** Forward downstream elicitation requests (ask the user) to the agent's client. */
  elicitation: z.boolean().default(false),
  /** Forward downstream sampling requests (ask the model) to the agent's client. */
  sampling: z.boolean().default(false)
});

export const GatewayConfigSchema = z.object({
  gateway: z.object({
    name: z.string().default("zak-mcp-gateway"),
    version: z.string().default("0.4.0"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    cache: GatewayCacheConfigSchema.default({}),
    discovery: GatewayDiscoveryConfigSchema.default({}),
    results: GatewayResultsConfigSchema.default({}),
    safety: GatewaySafetyConfigSchema.default({}),
    stats: GatewayStatsConfigSchema.default({}),
    codeMode: GatewayCodeModeConfigSchema.default({}),
    knowledge: GatewayKnowledgeConfigSchema.default({}),
    clientFeatures: GatewayClientFeaturesSchema.default({}),
    /** Named multi-step jobs the agent can run in one call: "wf__<name>". */
    workflows: z.record(WorkflowSchema).default({})
  }).passthrough().default({}),
  mcpServers: z.record(DownstreamServerConfigSchema).default({})
}).passthrough();

export type ValidatedGatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type DownstreamServerConfig = z.infer<typeof DownstreamServerConfigSchema>;
export type GatewayResultsConfig = z.infer<typeof GatewayResultsConfigSchema>;
export type GatewaySafetyConfig = z.infer<typeof GatewaySafetyConfigSchema>;
export type DistillMode = z.infer<typeof ServerResultsConfigSchema>["distill"];
export type WorkflowConfig = z.infer<typeof WorkflowSchema>;
export type WorkflowStepConfig = z.infer<typeof WorkflowStepSchema>;
