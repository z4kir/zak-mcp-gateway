import { DownstreamClientPool } from "../downstream/client-pool.js";
import { ExactMatchShaCache, stableStringify } from "../gate/sha-cache.js";
import { resolveRefs } from "./refs.js";
import { PolicyEngine } from "../gate/policy.js";
import { EgressDistiller } from "../distiller/egress.js";
import { TokenStats } from "../stats/token-stats.js";
import { ToolDiscoveryEngine } from "../discovery/search-index.js";
import { SchemaTranspiler } from "../synthesizer/ts-transpiler.js";
import { validateArgs } from "./arg-validator.js";
import { ProjectionFilter } from "../distiller/projection-filter.js";
import { KeyFilter } from "../distiller/key-filter.js";
import { NullPruner } from "../distiller/null-pruner.js";
import { DownstreamTool, ToolAccess, ToolCallPayload, ToolResult } from "../types/tool.js";
import { estimateTokens } from "../util/tokens.js";

export interface DispatcherOptions {
  cacheEnabled: boolean;
  inlineTokenLimit: number;
  warnOnInjection: boolean;
  writeReceipts?: boolean;
}

const MAX_BATCH = 50;

/**
 * Execution Dispatcher, the full lifecycle of one tool call:
 *   resolve name -> budget check -> default args -> policy (allow/deny, read-only, confirm
 *   writes) -> validate & repair args -> exact-match cache (reads) -> downstream call
 *   -> invalidate cache on writes -> egress distiller -> stats
 */
export class ExecutionDispatcher {
  constructor(
    private pool: DownstreamClientPool,
    private cache: ExactMatchShaCache,
    private policy: PolicyEngine,
    private egress: EgressDistiller,
    private stats: TokenStats,
    private discovery: ToolDiscoveryEngine,
    private options: DispatcherOptions
  ) {}

  public async executeTool(payload: ToolCallPayload, via = "call"): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.pool.resolveTool(payload.tool_name);
    if (!tool || !this.policy.isVisible(tool)) {
      return this.fail(this.unknownToolMessage(payload.tool_name), payload.tool_name, via, started);
    }

    const budgetError = this.budgetError();
    if (budgetError) return this.fail(budgetError, tool.namespacedName, via, started);

    let resolvedArgs: unknown;
    try {
      resolvedArgs = resolveRefs(payload.arguments, this.egress.store).value;
    } catch (err) {
      return this.fail((err as Error).message, tool.namespacedName, via, started);
    }

    const withDefaults = this.applyDefaultArgs(tool, resolvedArgs);
    const access = this.accessFor(tool, withDefaults);
    const decision = this.policy.check({ ...tool, access }, payload.confirm === true);
    if (!decision.allowed) return this.fail(decision.reason, tool.namespacedName, via, started, "policy");

    const check = validateArgs(tool, withDefaults);
    if (check.errors.length > 0) {
      return this.fail(
        `Invalid arguments for ${tool.namespacedName}: ${check.errors.join("; ")}.\n${SchemaTranspiler.transpileToTypeScript(tool)}`,
        tool.namespacedName, via, started
      );
    }

    const { raw, cacheHit } = await this.callDownstream(tool, check.args, access, payload.fresh === true);
    const serverConfig = this.pool.getServerConfig(tool.serverId);
    const ctx = {
      toolName: tool.namespacedName,
      serverId: tool.serverId,
      projectFields: payload.project_fields,
      defaultProjection: serverConfig?.projections?.[tool.name],
      extraDropKeys: serverConfig?.dropKeys,
      inlineTokenLimit: this.effectiveInlineLimit(serverConfig?.results?.inlineTokenLimit),
      maxStringChars: serverConfig?.results?.maxStringChars,
      distill: serverConfig?.results?.distill,
      warnOnInjection: this.options.warnOnInjection
    };
    const receipts = serverConfig?.results?.writeReceipts ?? this.options.writeReceipts ?? false;
    const outcome =
      access === "write" && receipts && !raw.isError && !payload.full && !payload.project_fields?.length
        ? this.egress.receipt(raw, ctx)
        : this.egress.process(raw, ctx);

    if (check.fixes.length > 0) {
      outcome.result.content.unshift({ type: "text", text: `[gateway: ${check.fixes.join(", ")}]` });
    }

    this.stats.recordCall({
      via,
      tool: tool.namespacedName,
      rawTokens: outcome.rawTokens,
      sentTokens: outcome.sentTokens,
      cacheHit,
      ms: Date.now() - started
    });
    return outcome.result;
  }

  /**
   * Batch: several calls in one turn, run in order, one result line each. If any call is a
   * write that needs confirmation and `confirm` is missing, nothing runs: the reply is a
   * preview of the writes so the agent can ask the user once for the whole batch.
   */
  public async executeBatch(calls: ToolCallPayload[], confirm: boolean, stopOnError = true): Promise<ToolResult> {
    if (calls.length === 0) return { content: [{ type: "text", text: "calls is empty." }], isError: true };
    if (calls.length > MAX_BATCH) return { content: [{ type: "text", text: `At most ${MAX_BATCH} calls per batch.` }], isError: true };

    if (!confirm) {
      const pending: string[] = [];
      calls.forEach((c, i) => {
        const tool = this.pool.resolveTool(c.tool_name);
        if (!tool || !this.policy.isVisible(tool)) return;
        const args = this.applyDefaultArgs(tool, c.arguments);
        const decision = this.policy.check({ ...tool, access: this.accessFor(tool, args) }, false);
        if (!decision.allowed && decision.needsConfirmation) {
          pending.push(`[${i}] ${tool.namespacedName} ${JSON.stringify(c.arguments ?? {}).slice(0, 160)}`);
        }
      });
      if (pending.length > 0) {
        return {
          content: [{ type: "text", text: `Batch not run: ${pending.length} of ${calls.length} calls change data:\n${pending.join("\n")}\nConfirm with the user, then repeat the same batch with "confirm": true.` }],
          isError: true
        };
      }
    }

    const lines: string[] = [];
    let failed = false;
    for (let i = 0; i < calls.length; i++) {
      const result = await this.executeTool({ ...calls[i], confirm }, "batch");
      const text = result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
      lines.push(`[${i}] ${calls[i].tool_name} ${result.isError ? "ERROR" : "ok"}: ${text}`);
      if (result.isError) {
        failed = true;
        if (stopOnError && i < calls.length - 1) {
          lines.push(`Stopped at [${i}]; calls [${i + 1}..${calls.length - 1}] were not run.`);
          break;
        }
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }], isError: failed };
  }

  /**
   * Raw access for code mode: same policy, validation and cache, no distillation. Returns
   * the parsed JSON (or text) of the result so the script can compute over it.
   */
  public async callForCode(name: string, args: unknown): Promise<{ value: unknown; rawTokens: number }> {
    const r = await this.callRaw(name, args, { confirm: false, inCodeMode: true, via: "run_code_step" });
    return { value: r.value, rawTokens: r.rawTokens };
  }

  /**
   * One tool call without distillation, for code mode and workflows: same name resolution,
   * $ref, default args, policy, validation and cache as a normal call. The full reply is
   * kept in the result store (handle) and the parsed value is returned. Throws on errors.
   */
  public async callRaw(
    name: string,
    args: unknown,
    opts: { confirm: boolean; inCodeMode?: boolean; via: string }
  ): Promise<{ value: unknown; text: string; rawTokens: number; handle: string; tool: string }> {
    const started = Date.now();
    const tool = this.pool.resolveTool(name);
    if (!tool || !this.policy.isVisible(tool)) throw new Error(this.unknownToolMessage(name));
    const withDefaults = this.applyDefaultArgs(tool, resolveRefs(args, this.egress.store).value);
    const access = this.accessFor(tool, withDefaults);
    const decision = this.policy.check({ ...tool, access }, opts.confirm, opts.inCodeMode ?? false);
    if (!decision.allowed) throw new Error(decision.reason);
    const check = validateArgs(tool, withDefaults);
    if (check.errors.length) throw new Error(`Invalid arguments for ${tool.namespacedName}: ${check.errors.join("; ")}`);

    const { raw, cacheHit } = await this.callDownstream(tool, check.args, access);
    const text = raw.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
    if (raw.isError) throw new Error(`${tool.namespacedName} failed: ${text.slice(0, 500)}`);
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* plain text result */
    }
    const rawTokens = estimateTokens(text);
    const handle = this.egress.store.put({ toolName: tool.namespacedName, serverId: tool.serverId, rawText: text, json: typeof value === "string" ? undefined : value });
    // These results are not sent to the model: they count as raw tokens kept out of context.
    this.stats.recordCall({ via: opts.via, tool: tool.namespacedName, rawTokens, sentTokens: 0, cacheHit, ms: Date.now() - started });
    return { value, text, rawTokens, handle, tool: tool.namespacedName };
  }

  /** Static read/write of a tool by name (unknown tools count as writes). */
  public staticAccess(name: string): ToolAccess {
    const tool = this.pool.resolveTool(name);
    if (!tool) return "write";
    const rules = this.pool.getServerConfig(tool.serverId)?.writeIf?.[tool.name];
    return tool.access === "write" || rules ? "write" : "read";
  }

  /**
   * The model-facing view of a raw value: projection (given fields, else the server's
   * default for that tool), noise keys and nulls removed. No clipping, no rendering.
   */
  public viewOf(toolName: string, value: unknown, fields?: string[]): unknown {
    const tool = this.pool.resolveTool(toolName);
    if (!tool || typeof value !== "object" || value === null) return value;
    const server = this.pool.getServerConfig(tool.serverId);
    const projected = ProjectionFilter.project(value, fields?.length ? fields : server?.projections?.[tool.name]);
    const cfg = this.egress.config;
    const filtered = KeyFilter.apply(projected, [...cfg.dropKeys, ...(server?.dropKeys ?? [])], cfg.keepKeys, Number.MAX_SAFE_INTEGER);
    return NullPruner.prune(filtered.value) ?? filtered.value;
  }

  /** Distill a gateway-built reply (e.g. a workflow summary) with the normal size limits. */
  public distillReply(result: ToolResult, toolName: string): ToolResult {
    return this.egress.process(result, {
      toolName,
      serverId: "gateway",
      inlineTokenLimit: this.effectiveInlineLimit(),
      warnOnInjection: this.options.warnOnInjection
    }).result;
  }

  public needsConfirmation(): boolean {
    return this.policy.confirmWritesEnabled();
  }

  /** Server-configured default arguments (page size, server-side field selection) the agent omitted. */
  private applyDefaultArgs(tool: DownstreamTool, args: unknown): unknown {
    const defaults = this.pool.getServerConfig(tool.serverId)?.defaultArgs?.[tool.name];
    if (!defaults || !args || typeof args !== "object" || Array.isArray(args)) return args ?? defaults ?? {};
    return { ...defaults, ...(args as Record<string, unknown>) };
  }

  /**
   * Read/write for this specific call: the tool's class (annotations, verbs, config
   * override), turned into a write when its arguments match a `writeIf` rule, e.g.
   * { "fetch_page": { "save": true } }.
   */
  public accessFor(tool: DownstreamTool, args: unknown): ToolAccess {
    if (tool.access === "write") return "write";
    const rule = this.pool.getServerConfig(tool.serverId)?.writeIf?.[tool.name];
    if (rule && args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      if (Object.entries(rule).every(([k, v]) => stableStringify(a[k]) === stableStringify(v))) return "write";
    }
    return "read";
  }

  private async callDownstream(
    tool: DownstreamTool,
    args: Record<string, unknown>,
    access: ToolAccess,
    fresh = false
  ): Promise<{ raw: ToolResult; cacheHit: boolean }> {
    const server = this.pool.getServerConfig(tool.serverId);
    const group = server?.cacheGroup ?? tool.serverId;
    const cacheable = this.options.cacheEnabled && server?.cache !== false && access === "read";
    const key = ExactMatchShaCache.computeKey(tool.namespacedName, args);
    if (cacheable && !fresh) {
      const cached = this.cache.get<ToolResult>(key);
      if (cached) return { raw: cached, cacheHit: true };
    }

    let raw: ToolResult;
    try {
      raw = await this.pool.callTool(tool, args);
    } catch (err) {
      raw = { content: [{ type: "text", text: `Downstream error from ${tool.namespacedName}: ${(err as Error).message}` }], isError: true };
    }

    if (access === "write") {
      this.cache.invalidateServer(group); // one write clears every server in its cache group
    } else if (cacheable && !raw.isError) {
      this.cache.set(key, raw, group, server?.cacheTtlSeconds ? server.cacheTtlSeconds * 1000 : undefined);
    }
    return { raw, cacheHit: false };
  }

  /** Dynamic token budgeting: past 80% of the session budget, results get half the inline room. */
  public effectiveInlineLimit(base = this.options.inlineTokenLimit): number {
    const ratio = this.stats.budgetRatio();
    return ratio >= 0.8 ? Math.floor(base / 2) : base;
  }

  public budgetError(): string | undefined {
    if (this.stats.budgetRatio() < 1) return undefined;
    const s = this.stats.summary();
    return `Session token budget exhausted (${s.sentTokens}/${s.budget} tokens returned). Summarize progress for the user instead of calling more tools.`;
  }

  private unknownToolMessage(name: string): string {
    const near = this.discovery
      .search(name.replace(/[_:.\/]+/g, " "), 3, 0.3, t => this.policy.isVisible(t))
      .map(s => s.namespacedName);
    return `Tool "${name}" not found.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use mcp_search_tools to find tools.`;
  }

  private fail(message: string, tool: string, via: string, started: number, blocked?: string): ToolResult {
    this.stats.recordCall({
      via,
      tool,
      rawTokens: 0,
      sentTokens: estimateTokens(message),
      cacheHit: false,
      blocked: blocked ?? "error",
      ms: Date.now() - started
    });
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
