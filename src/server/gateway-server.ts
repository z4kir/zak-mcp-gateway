import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { ValidatedGatewayConfig } from "../config/schema.js";
import { DownstreamClientPool, ServerStatus } from "../downstream/client-pool.js";
import { ToolDiscoveryEngine } from "../discovery/search-index.js";
import { buildCatalog, CatalogMode } from "../discovery/catalog.js";
import { matchesAny } from "../util/glob.js";
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
import { MCP_SEARCH_TOOLS, MCP_CALL_TOOL, MCP_GET_RESULT, MCP_RUN_CODE, MCP_GET_SKILL, MCP_STATUS, slimMetaTool } from "./meta-tools.js";
import { KnowledgeBase } from "../knowledge/knowledge-base.js";
import { WorkflowRunner, WORKFLOW_PREFIX, workflowSummaryTokens } from "../execution/workflows.js";

export interface GatewayServerOptions {
  /**
   * Baseline mode: expose every downstream tool with its original schema and return raw
   * results (no search, distillation or cache). Used to measure "standard MCP" honestly
   * through the same process and config.
   */
  passthrough?: boolean;
}

const STATS_URI = "zak://stats";
const SERVERS_URI = "zak://servers";

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
  private workflows?: WorkflowRunner;

  constructor(
    private config: ValidatedGatewayConfig & { configDir?: string },
    private options: GatewayServerOptions = {}
  ) {
    const g = config.gateway;
    log.setLevel(g.logLevel);
    this.pool = new DownstreamClientPool(g.clientFeatures);
    this.pool.onStatusChange(() => this.scheduleStatusWrite());
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

  /** Settles when every downstream server has connected or failed and setup is complete. */
  private downstreamReady: Promise<void> = Promise.resolve();
  private downstreamTools: DownstreamTool[] = [];
  /** Servers that were still starting when the agent's handshake was answered. */
  private startingServers: string[] = [];

  /**
   * Connect downstream servers, build the catalog, and create the upstream MCP server.
   * Waits at most `gateway.startupWaitMs` for slow servers so the agent's handshake is
   * answered in time (hosts allow about 30 s). Slower servers keep connecting in the
   * background: their tools become searchable and callable as soon as they are up.
   */
  public async initialize(): Promise<void> {
    for (const server of Object.values(this.config.mcpServers)) this.discovery.addSynonyms(server.synonyms ?? {});
    const all = this.pool.initializeServers(this.config.mcpServers, this.onServerReady);
    this.downstreamReady = all
      .then(tools => this.finishDownstream(tools))
      .catch(err => log.error(`[startup] setup after connecting failed: ${(err as Error).message}`));

    const waitMs = this.config.gateway.startupWaitMs;
    const inTime = waitMs > 0 ? await settlesWithin(this.downstreamReady, waitMs) : (await this.downstreamReady, true);
    if (!inTime) {
      this.startingServers = this.pool.pendingServers();
      log.warn(
        `[startup] still starting after ${waitMs} ms: ${this.startingServers.join(", ")}. ` +
          "Answering the agent now; their tools become usable as soon as they connect."
      );
    }
    this.instructions = this.buildInstructions();

    this.server = new Server(
      { name: this.config.gateway.name, version: this.config.gateway.version },
      { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: this.instructions || undefined }
    );
    this.setupHandlers(this.server);

    this.listedTools = JSON.stringify(this.listTools());
    void this.downstreamReady.then(() => {
      this.recordSession();
      this.notifyToolListChanged();
      this.writeStatusFile();
    });
  }

  /** Tools of a server that connected (at start or on reconnect) replace its old ones in search. */
  private readonly onServerReady = (serverId: string, tools: DownstreamTool[]): void => {
    this.discovery.removeServer(serverId);
    this.discovery.registerTools(tools);
    this.notifyToolListChanged();
  };

  /** tools/list as last sent; pinned servers and passthrough mode list downstream tools directly. */
  private listedTools?: string;

  private notifyToolListChanged(): void {
    if (this.listedTools === undefined) return; // before the handshake: the first tools/list is still to come
    const now = JSON.stringify(this.listTools());
    if (now === this.listedTools) return;
    this.listedTools = now;
    this.server?.sendToolListChanged().catch(() => undefined);
  }

  /** Runs once every server has connected or failed. */
  private finishDownstream(tools: DownstreamTool[]): void {
    this.downstreamTools = tools;
    if (!this.options.passthrough && Object.keys(this.config.gateway.workflows).length) {
      this.workflows = new WorkflowRunner(this.config.gateway.workflows, this.dispatcher, name => !!this.pool.resolveTool(name));
      this.discovery.registerTools(this.workflows.asTools());
    }
  }

  /** Tokens of the tool definitions an agent receives: every raw schema vs the gateway's list + instructions. */
  public schemaTokens(): { tools: number; direct: number; gateway: number } {
    const tools = this.downstreamTools;
    return {
      tools: tools.length,
      direct: estimateTokens(JSON.stringify({ tools: tools.map(rawToolDefinition) })),
      gateway: estimateTokens(JSON.stringify({ tools: this.listTools() })) + estimateTokens(this.instructions)
    };
  }

  private recordSession(): void {
    const t = this.schemaTokens();
    this.stats.recordSession({
      servers: Object.keys(this.config.mcpServers),
      toolCount: t.tools,
      baselineSchemaTokens: t.direct,
      gatewaySchemaTokens: t.gateway
    });
    log.info(
      `${t.tools} downstream tools. Tool definitions: ~${t.direct} tokens direct vs ~${t.gateway} via gateway` +
        (this.options.passthrough ? " (passthrough mode: no optimization)" : "")
    );
  }

  /** Resolves once every downstream server has connected or failed. */
  public whenDownstreamReady(): Promise<void> {
    return this.downstreamReady;
  }

  /**
   * Before a call that uses downstream tools. A call by name waits only for its own server and
   * reconnects it first if it is failed or disconnected (at most every status.retryAfterMs);
   * anything else waits for every server that is still starting. Returns an error result when
   * the named server is still down, saying why and how to retry.
   */
  private async prepareServers(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
    const toolName = name === "mcp_call_tool" && !Array.isArray(args.calls) ? args.tool_name : name;
    if (typeof toolName === "string") {
      const trimmed = toolName.trim();
      const serverId = trimmed.split(/__|::|\.|\/|:/)[0];
      if (serverId !== trimmed && serverId in this.config.mcpServers) {
        if (this.pool.pendingServers().includes(serverId)) {
          await this.pool.whenSettled(serverId);
        } else if (this.pool.canRetry(serverId, this.config.gateway.status.retryAfterMs)) {
          log.info(`[pool] ${serverId}: reconnecting for a call to ${trimmed}`);
          await this.pool.reconnect(serverId, this.onServerReady);
        }
        const st = this.pool.statusOf(serverId);
        if (st && (st.state === "failed" || st.state === "disconnected")) {
          const retry = this.config.gateway.status.tool ? ` mcp_status {"reconnect": "${serverId}"} retries now.` : "";
          return {
            content: [{ type: "text", text: `Server "${serverId}" is not connected (${st.state}: ${st.error ?? "unknown error"}).${retry}` }],
            isError: true
          };
        }
        return undefined;
      }
    }
    if (this.pool.pendingServers().length) await this.downstreamReady;
    return undefined;
  }

  /** One row per configured server: connection state plus what the config says about it. */
  public serverRows(): Array<ServerStatus & { label?: string; readOnly: boolean; confirmWrites: boolean; protected: boolean }> {
    return this.pool.serverStatus().map(st => {
      const cfg = this.config.mcpServers[st.serverId];
      return {
        ...st,
        label: cfg?.label,
        readOnly: !!cfg?.readOnly || this.config.gateway.safety.readOnly,
        confirmWrites: this.policy.confirmWritesEnabled(st.serverId),
        protected: this.pool.isProtected(st.serverId)
      };
    });
  }

  /** The status table mcp_status, the status prompt and the CLI show. */
  public statusTable(): string {
    return formatStatusTable(this.serverRows());
  }

  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const target = typeof args.reconnect === "string" ? args.reconnect.trim() : "";
    const notes: string[] = [];
    if (target) {
      if (target !== "all" && !(target in this.config.mcpServers)) {
        return { content: [{ type: "text", text: `Unknown server "${target}". Servers: ${Object.keys(this.config.mcpServers).join(", ")}` }], isError: true };
      }
      const ids = target === "all"
        ? this.pool.serverStatus().filter(st => st.state === "failed" || st.state === "disconnected").map(st => st.serverId)
        : [target];
      // A named server is reconnected even if it looks up (e.g. a remote server was redeployed).
      const results = await Promise.all(ids.map(id => this.pool.reconnect(id, this.onServerReady, target !== "all")));
      notes.push(
        ids.length
          ? `Reconnect: ${results.map(r => `${r.serverId} ${r.state === "ok" ? "ok" : `still ${r.state}`}`).join(", ")}`
          : "Reconnect: nothing to reconnect, every server is up or starting."
      );
    }
    const text = [this.statusTable(), ...notes].join("\n");
    this.stats.recordCall({ via: "status", tool: "mcp_status", rawTokens: 0, sentTokens: estimateTokens(text), cacheHit: false, ms: 0 });
    return { content: [{ type: "text", text }] };
  }

  /** status.json for status lines and scripts: next to the stats log unless configured. */
  public statusFilePath(): string | undefined {
    return resolveStatusFile(this.config);
  }

  private statusTimer?: NodeJS.Timeout;

  private scheduleStatusWrite(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.writeStatusFile();
    }, 150);
    this.statusTimer.unref();
  }

  public writeStatusFile(): void {
    const file = this.statusFilePath();
    if (!file) return;
    const body = {
      gateway: this.config.gateway.name,
      version: this.config.gateway.version,
      pid: process.pid,
      updated: new Date().toISOString(),
      configDir: this.config.configDir ?? process.cwd(),
      servers: this.serverRows().map(r => ({
        id: r.serverId,
        state: r.state,
        tools: r.tools ?? 0,
        label: r.label ?? null,
        readOnly: r.readOnly,
        confirmWrites: r.confirmWrites,
        protected: r.protected,
        error: r.error ?? null,
        since: r.since,
        attempts: r.attempts
      }))
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    } catch (err) {
      log.warn(`[status] cannot write ${file}: ${(err as Error).message}`);
    }
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
    if (this.config.gateway.status.tool) meta.push(MCP_STATUS);
    const styled = this.config.gateway.discovery.metaToolStyle === "slim" ? meta.map(slimMetaTool) : meta;
    const pinned = this.visibleTools()
      .filter(t => t.isPinned)
      .map(t => ({
        name: t.namespacedName,
        description: t.description,
        inputSchema: pinnedSchema(t, this.policy.confirmWritesEnabled(t.serverId))
      }) as Tool);
    return [...styled, ...pinned];
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
    const labels = Object.fromEntries(Object.entries(this.config.mcpServers).map(([id, c]) => [id, c.label]));
    lines.push(...buildCatalog(this.visibleTools(), mode, labels));
    const failed = this.pool.serverStatus().filter(st => st.state === "failed" || st.state === "disconnected");
    if (failed.length) {
      const why = failed.map(st => `${st.serverId} (${clipText(st.error ?? st.state, 100)})`).join("; ");
      lines.push(`Not connected: ${why}.${this.config.gateway.status.tool ? " mcp_status shows details and can reconnect." : ""}`);
    }
    if (this.startingServers.length) {
      lines.push(`Still starting: ${this.startingServers.join(", ")}. Their tools are not listed here yet; mcp_search_tools and mcp_call_tool wait for them.`);
    }

    // Hot signatures: the most-used tools from earlier sessions, so the agent can call them
    // without searching. Computed once at startup, so the instructions stay fixed.
    // Pinned (configured) + hot (learned) signatures: tools the agent can call without searching.
    const pinned = d.pinnedSignatures.length ? this.visibleTools().filter(t => matchesAny(t.namespacedName, d.pinnedSignatures)) : [];
    const hot = d.hotSignatures > 0
      ? this.stats.topTools(d.hotSignatures).map(name => this.pool.getTool(name)).filter((t): t is DownstreamTool => !!t && this.policy.isVisible(t))
      : [];
    const ready = [...new Map([...pinned, ...hot].map(t => [t.namespacedName, t])).values()];
    if (ready.length) lines.push(`Call directly, no search needed:\n${ready.map(t => SchemaTranspiler.oneLine(t)).join("\n")}`);

    const knowledge = this.knowledge.instructionsBlock();
    if (knowledge) lines.push(knowledge);

    if (d.serverInstructionsMaxChars > 0) {
      for (const [serverId, cfg] of Object.entries(this.config.mcpServers)) {
        if (cfg.forwardInstructions === false) continue;
        const own = this.pool.getServerInstructions(serverId);
        if (!own) continue;
        // The catalog already lists this server's tools: drop sentences that are tool inventories.
        const names = mode === "off" ? [] : this.visibleTools().filter(t => t.serverId === serverId).map(t => t.name);
        const text = dropToolInventory(own, names).replace(/\s+/g, " ").trim();
        if (!text) continue;
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
      resources: [
        { uri: STATS_URI, name: "Gateway token savings", mimeType: "application/json" },
        { uri: SERVERS_URI, name: "Servers behind the gateway", mimeType: "application/json" }
      ]
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
      if (request.params.uri === SERVERS_URI) {
        return { contents: [{ uri: SERVERS_URI, mimeType: "application/json", text: JSON.stringify(this.serverRows()) }] };
      }
      if (request.params.uri !== STATS_URI) throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: STATS_URI, mimeType: "application/json", text: JSON.stringify(this.stats.summary()) }] };
    });

    // A prompt the user can run without asking in words (Claude Code: /mcp__<gateway>__status).
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "status", description: "Servers behind the gateway: state, tools and last error" }]
    }));
    server.setRequestHandler(GetPromptRequestSchema, async request => {
      if (request.params.name !== "status") throw new Error(`Unknown prompt ${request.params.name}`);
      const text =
        `ZAK MCP Gateway status:\n${this.statusTable()}\n\n` +
        "Summarize this for me: which servers are not connected and what to fix. " +
        "The gateway has a tool whose name ends in mcp_status (load it if your tools are listed on demand): " +
        "call it with {\"reconnect\": \"<server>\"} to retry a server once its cause is fixed. Ask me before reconnecting.";
      return { description: "Gateway server status", messages: [{ role: "user", content: { type: "text", text } }] };
    });
  }

  public async handleCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== "mcp_get_result" && name !== "mcp_get_skill" && name !== "mcp_status") {
      const down = await this.prepareServers(name, args);
      if (down) return down;
    }
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
            .map(x => ({ name: x.namespacedName, description: x.description, inputSchema: pinnedSchema(x, this.policy.confirmWritesEnabled(x.serverId)), access: x.access }));
          return { content: [{ type: "text", text: JSON.stringify(defs) }] };
        }
        const full = args.detail === "full" ? matches.length : this.config.gateway.discovery.fullSignatures;
        const skill = this.knowledge.match(query);
        const skillLine = skill ? `Relevant skill: ${skill.name} (load it with mcp_get_skill first)\n\n` : "";
        const text = matches.length
          ? `${skillLine}${formatSearch(
              matches.map(m => {
                const tool = this.pool.getTool(m.namespacedName);
                return { ...m, oneLine: tool ? SchemaTranspiler.oneLine(tool) : undefined };
              }),
              full,
              { signature: this.config.gateway.discovery.signatureStyle, also: this.config.gateway.discovery.alsoStyle }
            )}`
          : `${skillLine}No tools matched "${query}". Try other words. Servers: ${Object.keys(this.config.mcpServers).join(", ")}`;
        this.stats.recordCall({ via: "search", tool: "mcp_search_tools", rawTokens: 0, sentTokens: estimateTokens(text), cacheHit: false, ms: Date.now() - started });
        return { content: [{ type: "text", text }] };
      }

      case "mcp_call_tool":
        if (typeof args.tool_name === "string" && this.workflows?.resolve(args.tool_name)) {
          return this.runWorkflow(args.tool_name, args.arguments ?? {}, args.confirm === true);
        }
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

      case "mcp_status":
        if (this.config.gateway.status.tool) return this.handleStatus(args);
        return { content: [{ type: "text", text: "mcp_status is turned off in the gateway config (gateway.status.tool)." }], isError: true };

      default: {
        if (name.startsWith(WORKFLOW_PREFIX) && this.workflows?.resolve(name)) {
          const { confirm: wfConfirm, ...wfArgs } = args;
          return this.runWorkflow(name, wfArgs, wfConfirm === true);
        }
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

  private async runWorkflow(name: string, input: unknown, confirm: boolean): Promise<ToolResult> {
    const started = Date.now();
    const budgetError = this.dispatcher.budgetError();
    if (budgetError) return { content: [{ type: "text", text: budgetError }], isError: true };
    const { result, rawTokens } = await this.workflows!.run(name, input, confirm);
    this.stats.recordCall({
      via: "workflow",
      tool: name.startsWith(WORKFLOW_PREFIX) ? name : `${WORKFLOW_PREFIX}${name}`,
      rawTokens,
      sentTokens: workflowSummaryTokens(result),
      cacheHit: false,
      blocked: result.isError ? "error" : undefined,
      ms: Date.now() - started
    });
    return result;
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

/** Remove lines/sentences naming 3+ of the server's tools (an inventory the catalog already gives). */
export function dropToolInventory(text: string, toolNames: string[]): string {
  if (toolNames.length === 0) return text;
  const names = new Set(toolNames.map(n => n.toLowerCase()));
  return text
    .split(/\n+/)
    .map(line =>
      line
        .split(/(?<=[.;])\s+/)
        .filter(sentence => {
          const words = new Set(sentence.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
          return [...names].filter(n => words.has(n)).length < 3;
        })
        .join(" ")
    )
    .filter(line => line.trim())
    .join("\n");
}

/** Top hits as full signatures, the rest as "name: summary" (detail:"full" shows all). */
function formatSearch(
  matches: { namespacedName: string; signatureText: string; summary: string; oneLine?: string }[],
  fullCount: number,
  style: { signature: "full" | "oneline"; also: "summary" | "name" } = { signature: "full", also: "summary" }
): string {
  const full = matches.slice(0, fullCount).map(m => (style.signature === "oneline" && m.oneLine ? m.oneLine : m.signatureText));
  const others = matches.slice(fullCount);
  if (others.length === 0) return full.join("\n\n");
  const rest = style.also === "name"
    ? `also: ${others.map(m => m.namespacedName).join(", ")}`
    : `also:\n${others.map(m => `- ${m.namespacedName}: ${m.summary}`).join("\n")}`;
  return [...full, rest].join(style.signature === "oneline" ? "\n" : "\n\n");
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

/** True if `promise` settles within `ms`, false otherwise. The timer never keeps the process alive. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** server | state | tools | note, aligned for a terminal or a chat reply. */
export function formatStatusTable(
  rows: Array<{ serverId: string; state: string; tools?: number; error?: string; label?: string; readOnly: boolean; confirmWrites: boolean; protected: boolean }>
): string {
  const table = rows.map(r => {
    const note = [
      r.label,
      r.readOnly ? "read-only" : r.confirmWrites ? "writes need confirm" : undefined,
      r.protected ? "full names only" : undefined,
      r.error ? clipText(r.error, 160) : undefined
    ].filter(Boolean).join("; ");
    const state = r.state === "failed" || r.state === "disconnected" ? r.state.toUpperCase() : r.state;
    return [r.serverId, state, r.state === "ok" ? String(r.tools ?? 0) : "-", note];
  });
  const head = ["server", "state", "tools", "note"];
  const widths = head.map((h, i) => Math.max(h.length, ...table.map(row => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(head), ...table.map(line)].join("\n");
}

/** Where the status file goes: gateway.status.file, else status.json next to the stats log; undefined when turned off. */
export function resolveStatusFile(config: ValidatedGatewayConfig & { configDir?: string }): string | undefined {
  const file = config.gateway.status.file;
  if (file === false) return undefined;
  const dir = config.configDir ?? process.cwd();
  return file ? path.resolve(dir, file) : path.join(path.dirname(path.resolve(dir, config.gateway.stats.logFile)), "status.json");
}
