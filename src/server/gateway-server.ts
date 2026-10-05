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
import { buildCatalog, CatalogMode } from "../discovery/catalog.js";
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
import { MCP_SEARCH_TOOLS, MCP_CALL_TOOL, MCP_GET_RESULT, MCP_RUN_CODE, MCP_GET_SKILL } from "./meta-tools.js";
import { KnowledgeBase } from "../knowledge/knowledge-base.js";

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
  public readonly pool: DownstreamClientPool;
  public readonly discovery = new ToolDiscoveryEngine();
  public readonly stats: TokenStats;
  public readonly dispatcher: ExecutionDispatcher;
  private server?: Server;
  private readonly policy: PolicyEngine;
  private readonly egress: EgressDistiller;
  private readonly cache: ExactMatchShaCache;
  private instructions = "";
  private readonly knowledge: KnowledgeBase;

  constructor(
    private config: ValidatedGatewayConfig & { configDir?: string },
    private options: GatewayServerOptions = {}
  ) {
    const g = config.gateway;
    log.setLevel(g.logLevel);
    this.pool = new DownstreamClientPool(g.clientFeatures);
    this.pool.setForwarder({
      elicit: async params => {
        if (!this.server?.getClientCapabilities()?.elicitation) return { action: "decline" };
        return this.server.elicitInput(params as never);
      },
      sample: async (params, serverId) => {
        if (!this.server?.getClientCapabilities()?.sampling) {
          throw new Error(`Server "${serverId}" asked for sampling, but the agent's client does not support it.`);
        }
        return this.server.createMessage(params as never);
      }
    });
    this.cache = new ExactMatchShaCache(g.cache.exactMatchTtlSeconds * 1000, g.cache.maxEntries);
    this.policy = new PolicyEngine(g.safety, config.mcpServers);
    this.egress = new EgressDistiller(g.results, new ResultStore(g.results.maxStored));
    this.knowledge = new KnowledgeBase(g.knowledge, config.configDir ?? process.cwd());
    this.stats = new TokenStats(g.stats.enabled, g.stats.logFile, config.configDir ?? process.cwd(), g.stats.sessionTokenBudget);
    this.dispatcher = new ExecutionDispatcher(this.pool, this.cache, this.policy, this.egress, this.stats, this.discovery, {
      cacheEnabled: g.cache.enabled,
      inlineTokenLimit: g.results.inlineTokenLimit,
      warnOnInjection: g.safety.warnOnInjection,
      writeReceipts: g.results.writeReceipts
    });
  }

  /** Connect downstream servers, build the catalog, and create the upstream MCP server. */
  public async initialize(): Promise<void> {
    const tools = await this.pool.initializeServers(this.config.mcpServers);
    for (const server of Object.values(this.config.mcpServers)) this.discovery.addSynonyms(server.synonyms ?? {});
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
    if (this.knowledge.hasSkills) meta.push(MCP_GET_SKILL);
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

  /**
   * Instructions sent once per session (fixed for the session, so prompt caching holds):
   * usage line, tool index (catalog mode), each server's own instructions (capped).
   */
  private buildInstructions(): string {
    if (this.options.passthrough) return "";
    const d = this.config.gateway.discovery;
    const lines = [
      "Tools below run via mcp_call_tool by name (a wrong argument returns the signature); use mcp_search_tools only if unsure. project_fields = only the fields you need."
    ];
    const mode: CatalogMode = d.catalog ?? (d.catalogInInstructions ? "names" : "off");
    lines.push(...buildCatalog(this.visibleTools(), mode));

    // Hot signatures: the most-used tools from earlier sessions, so the agent can call them
    // without searching. Computed once at startup, so the instructions stay fixed.
    if (d.hotSignatures > 0) {
      const hot = this.stats
        .topTools(d.hotSignatures)
        .map(name => this.pool.getTool(name))
        .filter((t): t is DownstreamTool => !!t && this.policy.isVisible(t));
      if (hot.length) lines.push(`Frequently used (call directly):\n${hot.map(t => SchemaTranspiler.oneLine(t)).join("\n")}`);
    }

    const knowledge = this.knowledge.instructionsBlock();
    if (knowledge) lines.push(knowledge);

    if (d.serverInstructionsMaxChars > 0) {
      for (const [serverId, cfg] of Object.entries(this.config.mcpServers)) {
        if (cfg.forwardInstructions === false) continue;
        const own = this.pool.getServerInstructions(serverId);
        if (!own) continue;
        const text = own.replace(/\s+/g, " ");
        const capped = text.length > d.serverInstructionsMaxChars ? `${text.slice(0, d.serverInstructionsMaxChars)}…` : text;
        lines.push(`[${serverId} notes] ${capped}`);
      }
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
        if (args.detail === "schema") {
          // For agent hosts (not the model): JSON schemas of the hits, to declare them as real
          // functions for weak models. Write tools get the gateway's `confirm` flag.
          const defs = matches
            .map(m => this.pool.getTool(m.namespacedName))
            .filter((x): x is DownstreamTool => !!x)
            .map(x => ({ name: x.namespacedName, description: x.description, inputSchema: pinnedSchema(x, this.config.gateway.safety.confirmWrites), access: x.access }));
          return { content: [{ type: "text", text: JSON.stringify(defs) }] };
        }
        const full = args.detail === "full" ? matches.length : this.config.gateway.discovery.fullSignatures;
        const skill = this.knowledge.match(query);
        const skillLine = skill ? `Relevant skill: ${skill.name} (load it with mcp_get_skill first)\n\n` : "";
        const text = matches.length
          ? `${skillLine}${formatSearch(matches, full)}`
          : `${skillLine}No tools matched "${query}". Try other words. Servers: ${Object.keys(this.config.mcpServers).join(", ")}`;
        this.stats.recordCall({ via: "search", tool: "mcp_search_tools", rawTokens: 0, sentTokens: estimateTokens(text), cacheHit: false, ms: Date.now() - started });
        return { content: [{ type: "text", text }] };
      }

      case "mcp_call_tool":
        if (Array.isArray(args.calls)) {
          const calls = (args.calls as Record<string, unknown>[]).map(c => ({
            tool_name: String(c?.tool_name ?? ""),
            arguments: (c?.arguments ?? {}) as Record<string, unknown>,
            project_fields: Array.isArray(c?.project_fields) ? (c.project_fields as unknown[]).map(String) : undefined
          }));
          return this.dispatcher.executeBatch(calls, args.confirm === true, args.stop_on_error !== false);
        }
        if (!args.tool_name) {
          return { content: [{ type: "text", text: "mcp_call_tool needs tool_name + arguments, or calls: [...]" }], isError: true };
        }
        return this.dispatcher.executeTool({
          tool_name: String(args.tool_name ?? ""),
          arguments: (args.arguments ?? {}) as Record<string, unknown>,
          project_fields: Array.isArray(args.project_fields) ? args.project_fields.map(String) : undefined,
          confirm: args.confirm === true,
          fresh: args.fresh === true,
          full: args.full === true
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
            raw: args.raw === true,
            count: args.count === true,
            groupBy: typeof args.group_by === "string" ? args.group_by : undefined,
            distinct: typeof args.distinct === "string" ? args.distinct : undefined,
            sort: typeof args.sort === "string" ? args.sort : undefined,
            path: typeof args.path === "string" ? args.path : undefined,
            maxTokens: typeof args.max_tokens === "number" ? args.max_tokens : undefined
          },
          budget
        );
        const fieldsUsed = [
          ...(Array.isArray(args.fields) ? args.fields.map(String) : []),
          ...[args.path, args.group_by, args.distinct].filter((x): x is string => typeof x === "string")
        ];
        this.stats.recordCall({
          via: "get_result",
          tool: out.source ?? String(args.handle ?? ""),
          rawTokens: 0,
          sentTokens: estimateTokens(out.text),
          cacheHit: false,
          ms: Date.now() - started,
          ...(fieldsUsed.length ? { fieldsUsed } : {})
        });
        return { content: [{ type: "text", text: out.text }], isError: out.isError };
      }

      case "mcp_get_skill": {
        const skill = this.knowledge.getSkill(String(args.name ?? ""));
        const text = skill
          ? `# ${skill.name}\n${skill.content}`
          : `Unknown skill "${args.name}". Available: ${this.knowledge.listSkills().map(s => s.name).join(", ") || "none"}`;
        this.stats.recordCall({ via: "skill", tool: String(args.name ?? ""), rawTokens: 0, sentTokens: estimateTokens(text), cacheHit: false, ms: 0 });
        return { content: [{ type: "text", text }], isError: !skill };
      }

      case "mcp_run_code":
        return this.handleRunCode(String(args.code ?? ""));

      default: {
        // A downstream tool called directly by its namespaced name (pinned tools, or hosts
        // that declare searched tools as real functions). `confirm` is the gateway's write
        // flag unless the tool itself has a parameter with that name.
        const tool = this.pool.resolveTool(name);
        const ownConfirm = !!tool?.inputSchema?.properties && "confirm" in tool.inputSchema.properties;
        const { confirm, ...rest } = args;
        return this.dispatcher.executeTool(
          { tool_name: tool?.namespacedName ?? name, arguments: ownConfirm ? args : rest, confirm: confirm === true },
          tool?.isPinned ? "pinned" : "direct"
        );
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

/** Top hits as full signatures, the rest as "name: summary" (detail:"full" shows all). */
function formatSearch(matches: { namespacedName: string; signatureText: string; summary: string }[], fullCount: number): string {
  const full = matches.slice(0, fullCount).map(m => m.signatureText);
  const rest = matches.slice(fullCount).map(m => `- ${m.namespacedName}: ${m.summary}`);
  return [...full, ...(rest.length ? [`also:\n${rest.join("\n")}`] : [])].join("\n\n");
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
