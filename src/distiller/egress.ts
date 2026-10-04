import { GatewayResultsConfig } from "../config/schema.js";
import { ToolResult, ToolResultContent } from "../types/tool.js";
import { ResultStore, StoredResult } from "../results/result-store.js";
import { estimateTokens } from "../util/tokens.js";
import { stableStringify } from "../gate/sha-cache.js";
import { ProjectionFilter } from "./projection-filter.js";
import { NullPruner } from "./null-pruner.js";
import { KeyFilter } from "./key-filter.js";
import { FormatConverter } from "./format-converter.js";
import { INJECTION_WARNING, looksLikeInjection } from "./injection-guard.js";

export interface EgressContext {
  toolName: string;
  serverId: string;
  /** Explicit projection from the agent. */
  projectFields?: string[];
  /** Server-configured default projection, used only when the agent passed none. */
  defaultProjection?: string[];
  /** Extra per-server key patterns to drop. */
  extraDropKeys?: string[];
  /** Effective inline budget (may be tightened by the session token budget). */
  inlineTokenLimit: number;
  warnOnInjection: boolean;
}

export interface EgressOutcome {
  result: ToolResult;
  rawTokens: number;
  sentTokens: number;
  handles: string[];
}

export interface GetResultArgs {
  handle: string;
  offset?: number;
  limit?: number;
  grep?: string;
  fields?: string[];
  raw?: boolean;
}

interface Rows {
  rows: unknown[];
  /** Name of the wrapping key when rows came from {meta..., items: [...]}. */
  key?: string;
  meta?: Record<string, unknown>;
}

/**
 * Egress Distiller:
 *   parse JSON -> projection -> noise-key drop + long-string clip -> null prune
 *   -> compact JSON or TSV -> if still over budget: store full result, return preview + handle
 */
export class EgressDistiller {
  constructor(
    private config: GatewayResultsConfig,
    private store: ResultStore
  ) {}

  public process(result: ToolResult, ctx: EgressContext): EgressOutcome {
    let content = Array.isArray(result.content) ? result.content : [];
    if (!content.some(c => c.type === "text") && result.structuredContent !== undefined) {
      content = [...content, { type: "text", text: JSON.stringify(result.structuredContent) }];
    }
    let rawTokens = 0;
    let sentTokens = 0;
    const handles: string[] = [];
    const out: ToolResultContent[] = [];

    for (const item of content) {
      if (item.type !== "text" || typeof item.text !== "string") {
        out.push(item); // images, resources: passed through untouched
        continue;
      }
      rawTokens += estimateTokens(item.text);
      const { text, handle } = result.isError ? { text: item.text, handle: undefined } : this.distillText(item.text, ctx);
      const flagged = ctx.warnOnInjection && looksLikeInjection(item.text) ? `${INJECTION_WARNING}\n${text}` : text;
      if (handle) handles.push(handle);
      sentTokens += estimateTokens(flagged);
      out.push({ type: "text", text: flagged });
    }

    // structuredContent duplicates the text for MCP clients that support it. The model only
    // needs one copy, and the distilled text is the one we control, so it is dropped here.
    const { structuredContent: _dropped, ...rest } = result;
    return { result: { ...rest, content: out }, rawTokens, sentTokens, handles };
  }

  private distillText(text: string, ctx: EgressContext): { text: string; handle?: string } {
    const json = tryParseJson(text);
    if (json === undefined) return this.distillPlainText(text, ctx);

    const fields = ctx.projectFields?.length ? ctx.projectFields : ctx.defaultProjection;
    const usedDefaultProjection = !ctx.projectFields?.length && !!ctx.defaultProjection?.length;

    // Pass 1: projection, noise keys, nulls. No string clipping yet.
    const projected = ProjectionFilter.project(json, fields);
    const filtered = KeyFilter.apply(
      projected,
      [...this.config.dropKeys, ...(ctx.extraDropKeys ?? [])],
      this.config.keepKeys,
      Number.MAX_SAFE_INTEGER
    );
    let value: unknown = NullPruner.prune(filtered.value) ?? (Array.isArray(filtered.value) ? [] : {});
    let rendered = FormatConverter.render(value, this.config.tsv);
    const fullTokens = estimateTokens(rendered);
    let clipped = 0;

    // Pass 2 (only when over budget): clip long strings. Lists clip every long field
    // (bodies, patches); a single object keeps as much of its strings as still fits,
    // so "read README" returns most of the README, not 600 characters of it.
    if (fullTokens > ctx.inlineTokenLimit) {
      const clipAt = extractRows(value) ? this.config.maxStringChars : this.largestFittingClip(value, ctx.inlineTokenLimit);
      const c = KeyFilter.apply(value, [], [], clipAt);
      if (c.clippedStrings > 0) {
        value = c.value;
        clipped = c.clippedStrings;
        rendered = FormatConverter.render(value, this.config.tsv);
      }
    }

    const renderedTokens = estimateTokens(rendered);
    const lossy = usedDefaultProjection || filtered.droppedKeys > 0 || clipped > 0;

    if (renderedTokens <= ctx.inlineTokenLimit) {
      if (!lossy) return { text: rendered };
      const handle = this.save(text, json, ctx);
      const why = [
        usedDefaultProjection ? "default fields" : "",
        filtered.droppedKeys ? "noise keys removed" : "",
        clipped ? `${clipped} long strings clipped` : ""
      ].filter(Boolean).join(", ");
      return { text: `${rendered}\n[${handle}: ${why}; full data via mcp_get_result]`, handle };
    }

    const handle = this.save(text, json, ctx);
    return { text: this.preview(value, handle, fullTokens, ctx.inlineTokenLimit), handle };
  }

  /** Largest per-string clip length (>= maxStringChars) at which the value fits the budget. */
  private largestFittingClip(value: unknown, budget: number): number {
    let lo = this.config.maxStringChars;
    let hi = longestString(value);
    if (hi <= lo) return lo;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const t = estimateTokens(FormatConverter.render(KeyFilter.apply(value, [], [], mid).value, this.config.tsv));
      if (t <= budget - 40) lo = mid; // leave room for the handle note
      else hi = mid - 1;
    }
    return lo;
  }

  private distillPlainText(text: string, ctx: EgressContext): { text: string; handle?: string } {
    const tokens = estimateTokens(text);
    if (tokens <= ctx.inlineTokenLimit) return { text };
    const handle = this.save(text, undefined, ctx);
    const lines = text.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const t = estimateTokens(line) + 1;
      if (used + t > ctx.inlineTokenLimit && kept.length > 0) break;
      kept.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
      used += t;
    }
    return {
      text: `${kept.join("\n")}\n[${handle}: showing lines 1-${kept.length} of ${lines.length} (~${tokens} tokens). mcp_get_result {handle:"${handle}", offset, limit, grep}]`,
      handle
    };
  }

  private preview(value: unknown, handle: string, totalTokens: number, budget: number): string {
    const found = extractRows(value);
    if (found && found.rows.length > 0) {
      const maxRows = Math.min(this.config.previewRows, found.rows.length);
      let n = maxRows;
      let body = "";
      // Shrink the preview until it fits the budget (at least one row).
      while (n >= 1) {
        body = FormatConverter.render(found.rows.slice(0, n), this.config.tsv);
        if (estimateTokens(body) <= budget || n === 1) break;
        n = Math.max(1, Math.floor(n / 2));
      }
      if (estimateTokens(body) > budget) body = clipToTokens(body, budget);
      const meta = found.meta && Object.keys(found.meta).length ? `${JSON.stringify(found.meta)}\n` : "";
      const where = found.key ? ` in "${found.key}"` : "";
      return `${meta}${body}\n[${handle}: showing ${n} of ${found.rows.length} rows${where} (~${totalTokens} tokens total). mcp_get_result {handle:"${handle}", offset:${n}, limit, grep, fields}]`;
    }
    const rendered = FormatConverter.render(value, this.config.tsv);
    return `${clipToTokens(rendered, budget)}\n[${handle}: truncated (~${totalTokens} tokens total). mcp_get_result {handle:"${handle}", offset, limit, fields} pages it]`;
  }

  private save(rawText: string, json: unknown, ctx: EgressContext): string {
    return this.store.put({ toolName: ctx.toolName, serverId: ctx.serverId, rawText, json });
  }

  /** mcp_get_result: page / grep / project a stored result. */
  public getResult(args: GetResultArgs, budget: number): { text: string; isError?: boolean } {
    const entry = this.store.get(args.handle);
    if (!entry) {
      return { text: `Unknown or expired handle "${args.handle}". Re-run the tool call.`, isError: true };
    }
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit = Math.max(1, Math.floor(args.limit ?? this.config.previewRows * 2));
    const grep = args.grep ? safeRegExp(args.grep) : undefined;

    if (args.raw || entry.json === undefined) return this.pageLines(entry, offset, limit, grep, budget);

    const cleaned = KeyFilter.apply(entry.json, this.config.dropKeys, this.config.keepKeys, this.config.maxStringChars * 8);
    const value = NullPruner.prune(cleaned.value) ?? cleaned.value;
    const found = extractRows(value);

    if (found) {
      let rows = found.rows;
      if (grep) rows = rows.filter(r => grep.test(stableStringify(r)));
      const page = rows.slice(offset, offset + limit);
      const projected = ProjectionFilter.project(page, args.fields);
      let body = FormatConverter.render(projected, this.config.tsv);
      let note = "";
      if (estimateTokens(body) > budget) {
        body = clipToTokens(body, budget);
        note = " (clipped: use a smaller limit or fields)";
      }
      const matched = grep ? `, ${rows.length} match grep` : "";
      return { text: `[${entry.handle} rows ${offset}-${offset + page.length - 1} of ${found.rows.length}${matched}${note}]\n${body}` };
    }

    const projected = ProjectionFilter.project(value, args.fields);
    const text = FormatConverter.render(projected, false);
    // Non-tabular JSON: offset/limit page by characters (limit given in rows is scaled up).
    const charLimit = args.limit ? args.limit * 200 : budget * 3;
    const slice = text.slice(offset, offset + charLimit);
    const more = offset + slice.length < text.length ? ` · next offset ${offset + slice.length}` : "";
    return { text: `[${entry.handle} chars ${offset}-${offset + slice.length} of ${text.length}${more}]\n${clipToTokens(slice, budget)}` };
  }

  private pageLines(entry: StoredResult, offset: number, limit: number, grep: RegExp | undefined, budget: number) {
    let lines = entry.rawText.split("\n").map((line, i) => ({ line, n: i + 1 }));
    if (grep) lines = lines.filter(l => grep.test(l.line));
    const page = lines.slice(offset, offset + limit);
    const body = clipToTokens(page.map(l => (grep ? `${l.n}: ${l.line}` : l.line)).join("\n"), budget);
    const matched = grep ? ` (${lines.length} lines match grep)` : "";
    return { text: `[${entry.handle} raw lines ${offset}-${offset + page.length - 1} of ${lines.length}${matched}]\n${body}` };
  }
}

/** Find the list inside a result: the value itself, or the one array field of a wrapper object. */
export function extractRows(value: unknown): Rows | undefined {
  if (Array.isArray(value)) return { rows: value };
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const arrays = entries.filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0);
    if (arrays.length === 1) {
      const [key, rows] = arrays[0];
      const meta = Object.fromEntries(entries.filter(([k, v]) => k !== key && (v === null || typeof v !== "object")));
      return { rows: rows as unknown[], key, meta };
    }
  }
  return undefined;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((m: number, v) => Math.max(m, longestString(v)), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce((m: number, v) => Math.max(m, longestString(v)), 0);
  }
  return 0;
}

function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function clipToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
