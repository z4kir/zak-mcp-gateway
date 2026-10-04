import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { ValidatedGatewayConfig } from "../config/schema.js";
import { DownstreamClientPool } from "../downstream/client-pool.js";
import { ToolDiscoveryEngine } from "../discovery/search-index.js";
import { ExactMatchShaCache } from "../gate/sha-cache.js";
import { PolicyEngine } from "../gate/policy.js";
import { ResultStore } from "../results/result-store.js";
import { EgressDistiller } from "../distiller/egress.js";
import { TokenStats } from "../stats/token-stats.js";
import { ExecutionDispatcher } from "../execution/dispatcher.js";
import { runCode } from "../execution/code-mode.js";
import { SchemaTranspiler } from "../synthesizer/ts-transpiler.js";
import { DownstreamTool, ToolResult } from "../types/tool.js";
import { estimateTokens } from "../util/tokens.js";
import { log } from "../util/log.js";
import { MCP_SEARCH_TOOLS, MCP_CALL_TOOL, MCP_GET_RESULT, MCP_RUN_CODE } from "./meta-tools.js";

export interface GatewayServerOptions {
  /**
   * Baseline mode: expose every downstream tool with its original schema and return raw
   * results (no search, distillation or cache). Used to measure "standard MCP" honestly
   * through the same process and config.
   */
  passthrough?: boolean;
}

const STATS_URI = "zak://stats";

/**
 * TO-MCP Gateway Server:
 * One MCP server for the agent; many MCP servers behind it. The agent sees a few meta-tools
 * and a one-line-per-server catalog instead of every schema.
 */
export class GatewayServer {
  public readonly pool = new DownstreamClientPool();
  public readonly discovery = new ToolDiscoveryEngine();
  public readonly stats: TokenStats;
  public readonly dispatcher: ExecutionDispatcher;
  private server?: Server;
  private readonly policy: PolicyEngine;
  private readonly egress: EgressDistiller;
  private readonly cache: ExactMatchShaCache;
  private instructions = "";

  constructor(
    private config: ValidatedGatewayConfig & { configDir?: string },
    private options: GatewayServerOptions = {}
  ) {
    const g = config.gateway;
    log.setLevel(g.logLevel);
    this.cache = new ExactMatchShaCache(g.cache.exactMatchTtlSeconds * 1000, g.cache.maxEntries);
    this.policy = new PolicyEngine(g.safety, config.mcpServers);
    this.egress = new EgressDistiller(g.results, new ResultStore(g.results.maxStored));
    this.stats = new TokenStats(g.stats.enabled, g.stats.logFile, config.configDir ?? process.cwd(), g.stats.sessionTokenBudget);
    this.dispatcher = new ExecutionDispatcher(this.pool, this.cache, this.policy, this.egress, this.stats, this.discovery, {
      cacheEnabled: g.cache.enabled,
      inlineTokenLimit: g.results.inlineTokenLimit,
      warnOnInjection: g.safety.warnOnInjection
    });
  }

  /** Connect downstream servers, build the catalog, and create the upstream MCP server. */
  public async initialize(): Promise<void> {
    const tools = await this.pool.initializeServers(this.config.mcpServers);
    this.discovery.registerTools(tools);
    this.instructions = this.buildInstructions();

    this.server = new Server(
      { name: this.config.gateway.name, version: this.config.gateway.version },
      { capabilities: { tools: {}, resources: {} }, instructions: this.instructions || undefined }
    );
    this.setupHandlers(this.server);

    const baselineSchemaTokens = estimateTokens(JSON.stringify({ tools: tools.map(rawToolDefinition) }));
    const gatewaySchemaTokens = estimateTokens(JSON.stringify({ tools: this.listTools() })) + estimateTokens(this.instructions);
    this.stats.recordSession({
      servers: Object.keys(this.config.mcpServers),
      toolCount: tools.length,
      baselineSchemaTokens,
      gatewaySchemaTokens
    });
    log.info(
      `${tools.length} downstream tools. Tool definitions: ~${baselineSchemaTokens} tokens direct vs ~${gatewaySchemaTokens} via gateway` +
        (this.options.passthrough ? " (passthrough mode: no optimization)" : "")
    );
  }

  public async connect(transport: Transport): Promise<void> {
    if (!this.server) await this.initialize();
    await this.server!.connect(transport);
  }

  public async start(): Promise<void> {
    await this.connect(new StdioServerTransport());
  }

  public async close(): Promise<void> {
    await this.server?.close();
    await this.pool.closeAll();
  }

  public getInstructions(): string {
    return this.instructions;
  }

  private visibleTools(): DownstreamTool[] {
    return this.discovery.getAllTools().filter(t => this.policy.isVisible(t));
  }

  /** What tools/list returns. */
  public listTools(): Tool[] {
    if (this.options.passthrough) {
      return this.visibleTools().map(t => ({ ...rawToolDefinition(t), name: t.namespacedName }) as Tool);
    }
    const meta = [MCP_SEARCH_TOOLS, MCP_CALL_TOOL, MCP_GET_RESULT];
    if (this.config.gateway.codeMode.enabled) meta.push(MCP_RUN_CODE);
    const pinned = this.visibleTools()
      .filter(t => t.isPinned)
      .map(t => ({
        name: t.namespacedName,
        description: t.description,
        inputSchema: pinnedSchema(t, this.config.gateway.safety.confirmWrites)
      }) as Tool);
    return [...meta, ...pinned];
  }

  /** A compact "server: tool, tool, ..." index so the model knows what exists without schemas. */
  private buildInstructions(): string {
    if (this.options.passthrough) return "";
    const lines = [
      "MCP tools below are reached via this gateway: find with mcp_search_tools, run with mcp_call_tool (call directly if you know the args; errors return the signature). Use project_fields to fetch only needed fields."
    ];
    if (this.config.gateway.discovery.catalogInInstructions) {
      const byServer = new Map<string, string[]>();
      for (const t of this.visibleTools()) {
        if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
        byServer.get(t.serverId)!.push(t.name);
      }
      for (const [server, names] of byServer) lines.push(`${server} (prefix ${server}__): ${names.join(", ")}`);
    }
    return lines.join("\n");
  }

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));

    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params;
      try {
        return (await this.handleCall(name, args as Record<string, unknown>)) as never;
      } catch (err) {
        return { content: [{ type: "text", text: `Gateway error: ${(err as Error).message}` }], isError: true };
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: STATS_URI, name: "Gateway token savings", mimeType: "application/json" }]
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
      if (request.params.uri !== STATS_URI) throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: STATS_URI, mimeType: "application/json", text: JSON.stringify(this.stats.summary()) }] };
    });
  }

  public async handleCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.options.passthrough) return this.passthroughCall(name, args);

    switch (name) {
      case "mcp_search_tools": {
        const started = Date.now();
        const query = String(args.query ?? "");
        const limit = typeof args.limit === "number" ? args.limit : this.config.gateway.discovery.maxSearchResults;
        const matches = this.discovery.search(query, limit, this.config.gateway.discovery.minScore, t => this.policy.isVisible(t));
        const text = matches.length
          ? matches.map(m => m.signatureText).join("\n\n")
          : `No tools matched "${query}". Try other words. Servers: ${Object.keys(this.config.mcpServers).join(", ")}`;
        this.stats.recordCall({ via: "search", tool: "mcp_search_tools", rawTokens: 0, sentTokens: estimateTokens(text), cacheHit: false, ms: Date.now() - started });
        return { content: [{ type: "text", text }] };
      }

      case "mcp_call_tool":
        return this.dispatcher.executeTool({
          tool_name: String(args.tool_name ?? ""),
          arguments: (args.arguments ?? {}) as Record<string, unknown>,
          project_fields: Array.isArray(args.project_fields) ? args.project_fields.map(String) : undefined,
          confirm: args.confirm === true
        });

      case "mcp_get_result": {
        const started = Date.now();
        const budget = this.dispatcher.effectiveInlineLimit() * 2;
        const out = this.egress.getResult(
          {
            handle: String(args.handle ?? ""),
            offset: typeof args.offset === "number" ? args.offset : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            grep: typeof args.grep === "string" ? args.grep : undefined,
            fields: Array.isArray(args.fields) ? args.fields.map(String) : undefined,
            raw: args.raw === true
          },
          budget
        );
        this.stats.recordCall({ via: "get_result", tool: String(args.handle ?? ""), rawTokens: 0, sentTokens: estimateTokens(out.text), cacheHit: false, ms: Date.now() - started });
        return { content: [{ type: "text", text: out.text }], isError: out.isError };
      }

      case "mcp_run_code":
        return this.handleRunCode(String(args.code ?? ""));

      default: {
        // Pinned tool called directly by its namespaced name.
        const tool = this.pool.resolveTool(name);
        if (!tool?.isPinned) {
          return this.dispatcher.executeTool({ tool_name: name, arguments: args }, "pinned");
        }
        const { confirm, ...toolArgs } = args;
        return this.dispatcher.executeTool({ tool_name: tool.namespacedName, arguments: toolArgs, confirm: confirm === true }, "pinned");
      }
    }
  }

  private async handleRunCode(code: string): Promise<ToolResult> {
    const cfg = this.config.gateway.codeMode;
    if (!cfg.enabled) return { content: [{ type: "text", text: "Code mode is disabled in the gateway config." }], isError: true };
    const budgetError = this.dispatcher.budgetError();
    if (budgetError) return { content: [{ type: "text", text: budgetError }], isError: true };

    const started = Date.now();
    try {
      const out = await runCode(code, this.dispatcher, cfg);
      const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(out.value) }] };
      const distilled = this.egress.process(result, {
        toolName: "mcp_run_code",
        serverId: "gateway",
        inlineTokenLimit: this.dispatcher.effectiveInlineLimit(),
        warnOnInjection: this.config.gateway.safety.warnOnInjection
      });
      if (out.logs.length) distilled.result.content.push({ type: "text", text: `[logs]\n${out.logs.join("\n")}` });
      this.stats.recordCall({
        via: "run_code",
        tool: `mcp_run_code(${out.toolCalls} calls)`,
        rawTokens: out.intermediateTokens,
        sentTokens: distilled.sentTokens,
        cacheHit: false,
        ms: Date.now() - started
      });
      return distilled.result;
    } catch (err) {
      return { content: [{ type: "text", text: `mcp_run_code failed: ${(err as Error).message}` }], isError: true };
    }
  }

  private async passthroughCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.pool.resolveTool(name);
    if (!tool || !this.policy.isVisible(tool)) {
      return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
    }
    const raw = await this.pool.callTool(tool, args);
    const tokens = raw.content.reduce((s, c) => s + (typeof c.text === "string" ? estimateTokens(c.text) : 0), 0);
    this.stats.recordCall({ via: "passthrough", tool: tool.namespacedName, rawTokens: tokens, sentTokens: tokens, cacheHit: false, ms: Date.now() - started });
    return raw;
  }
}

/** A tool exactly as its own server advertises it (the "standard MCP" baseline). */
function rawToolDefinition(t: DownstreamTool): Record<string, unknown> {
  const def: Record<string, unknown> = { name: t.name, description: t.description, inputSchema: t.inputSchema };
  if (t.outputSchema) def.outputSchema = t.outputSchema;
  if (t.annotations) def.annotations = t.annotations;
  return def;
}

/** Minified schema for pinned tools; write tools get a `confirm` flag for the safety gate. */
function pinnedSchema(t: DownstreamTool, confirmWrites: boolean): Tool["inputSchema"] {
  const schema = SchemaTranspiler.minifySchema(t.inputSchema) as Tool["inputSchema"];
  if (t.access === "write" && confirmWrites) {
    schema.properties = {
      ...(schema.properties ?? {}),
      confirm: { type: "boolean", description: "true only after the user approved this change" }
    };
  }
  return schema;
}
