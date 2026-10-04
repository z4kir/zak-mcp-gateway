import { DownstreamClientPool } from "../downstream/client-pool.js";
import { ExactMatchShaCache } from "../gate/sha-cache.js";
import { PolicyEngine } from "../gate/policy.js";
import { EgressDistiller } from "../distiller/egress.js";
import { TokenStats } from "../stats/token-stats.js";
import { ToolDiscoveryEngine } from "../discovery/search-index.js";
import { SchemaTranspiler } from "../synthesizer/ts-transpiler.js";
import { validateArgs } from "./arg-validator.js";
import { DownstreamTool, ToolCallPayload, ToolResult } from "../types/tool.js";
import { estimateTokens } from "../util/tokens.js";

export interface DispatcherOptions {
  cacheEnabled: boolean;
  inlineTokenLimit: number;
  warnOnInjection: boolean;
}

/**
 * Execution Dispatcher, the full lifecycle of one tool call:
 *   resolve name -> budget check -> policy (allow/deny, read-only, confirm writes)
 *   -> validate & repair args -> exact-match cache (reads) -> downstream call
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

    const decision = this.policy.check(tool, payload.confirm === true);
    if (!decision.allowed) return this.fail(decision.reason, tool.namespacedName, via, started, "policy");

    const check = validateArgs(tool, payload.arguments);
    if (check.errors.length > 0) {
      return this.fail(
        `Invalid arguments for ${tool.namespacedName}: ${check.errors.join("; ")}.\n${SchemaTranspiler.transpileToTypeScript(tool)}`,
        tool.namespacedName, via, started
      );
    }

    const { raw, cacheHit } = await this.callDownstream(tool, check.args);
    const serverConfig = this.pool.getServerConfig(tool.serverId);
    const outcome = this.egress.process(raw, {
      toolName: tool.namespacedName,
      serverId: tool.serverId,
      projectFields: payload.project_fields,
      defaultProjection: serverConfig?.projections?.[tool.name],
      extraDropKeys: serverConfig?.dropKeys,
      inlineTokenLimit: this.effectiveInlineLimit(),
      warnOnInjection: this.options.warnOnInjection
    });

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
   * Raw access for code mode: same policy, validation and cache, no distillation. Returns
   * the parsed JSON (or text) of the result so the script can compute over it.
   */
  public async callForCode(name: string, args: unknown): Promise<{ value: unknown; rawTokens: number }> {
    const tool = this.pool.resolveTool(name);
    if (!tool || !this.policy.isVisible(tool)) throw new Error(this.unknownToolMessage(name));
    const decision = this.policy.check(tool, false, true);
    if (!decision.allowed) throw new Error(decision.reason);
    const check = validateArgs(tool, args);
    if (check.errors.length) throw new Error(`Invalid arguments for ${tool.namespacedName}: ${check.errors.join("; ")}`);

    const { raw } = await this.callDownstream(tool, check.args);
    const text = raw.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
    if (raw.isError) throw new Error(`${tool.namespacedName} failed: ${text}`);
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* plain text result */
    }
    return { value, rawTokens: estimateTokens(text) };
  }

  private async callDownstream(tool: DownstreamTool, args: Record<string, unknown>): Promise<{ raw: ToolResult; cacheHit: boolean }> {
    const cacheable = this.options.cacheEnabled && tool.access === "read";
    const key = ExactMatchShaCache.computeKey(tool.namespacedName, args);
    if (cacheable) {
      const cached = this.cache.get<ToolResult>(key);
      if (cached) return { raw: cached, cacheHit: true };
    }

    let raw: ToolResult;
    try {
      raw = await this.pool.callTool(tool, args);
    } catch (err) {
      raw = { content: [{ type: "text", text: `Downstream error from ${tool.namespacedName}: ${(err as Error).message}` }], isError: true };
    }

    if (tool.access === "write") {
      this.cache.invalidateServer(tool.serverId);
    } else if (cacheable && !raw.isError) {
      this.cache.set(key, raw, tool.serverId);
    }
    return { raw, cacheHit: false };
  }

  /** Dynamic token budgeting: past 80% of the session budget, results get half the inline room. */
  public effectiveInlineLimit(): number {
    const ratio = this.stats.budgetRatio();
    return ratio >= 0.8 ? Math.floor(this.options.inlineTokenLimit / 2) : this.options.inlineTokenLimit;
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
