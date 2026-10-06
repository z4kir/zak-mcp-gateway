import MiniSearch from "minisearch";
import { DownstreamTool, CompactToolSignature } from "../types/tool.js";
import { SchemaTranspiler } from "../synthesizer/ts-transpiler.js";
import { singular } from "./catalog.js";

interface IndexedToolDocument {
  id: string; // namespacedName
  serverId: string;
  name: string;
  description: string;
  parameters: string;
}

/** Everyday words -> the vocabulary MCP tool names actually use. */
const SYNONYMS: Record<string, string[]> = {
  pr: ["pull", "request"],
  prs: ["pull", "request"],
  mr: ["pull", "request"],
  repo: ["repository"],
  repos: ["repository"],
  ticket: ["issue"],
  tickets: ["issue"],
  bug: ["issue"],
  bugs: ["issue"],
  commits: ["commit"],
  history: ["commits", "list"],
  log: ["commits"],
  folder: ["directory"],
  dir: ["directory"],
  ls: ["list", "directory"],
  cat: ["read", "file"],
  open: ["create", "read", "get"],
  file: ["file", "contents"],
  show: ["get", "list"],
  fetch: ["get"],
  make: ["create"],
  new: ["create"],
  add: ["create", "add"],
  edit: ["update", "edit"],
  change: ["update", "edit"],
  modify: ["update", "edit"],
  delete: ["delete", "remove"],
  remove: ["delete", "remove"],
  find: ["search"],
  lookup: ["search", "get"],
  sql: ["query"],
  db: ["query", "database"],
  table: ["query"],
  review: ["review", "reviews"],
  diff: ["files", "diff"],
  changes: ["files", "diff"],
  comment: ["comment", "comments"],
  merge: ["merge"],
  user: ["users"],
  people: ["users"],
  many: ["count"],
  number: ["count"],
  total: ["count"],
  field: ["field", "column"],
  column: ["column", "field"]
};

/**
 * JIT Tool Discovery Engine:
 * BM25 (MiniSearch) over tool names, descriptions and parameter names, with fuzzy + prefix
 * matching and a small synonym map. Returns compact signatures for the best matches only.
 */
export class ToolDiscoveryEngine {
  private miniSearch: MiniSearch<IndexedToolDocument>;
  private toolRegistry = new Map<string, DownstreamTool>();
  private synonyms: Record<string, string[]> = { ...SYNONYMS };

  constructor() {
    this.miniSearch = new MiniSearch<IndexedToolDocument>({
      fields: ["name", "description", "serverId", "parameters"],
      storeFields: ["id"],
      // snake_case and camelCase names become separate words: list_commits -> list commits
      tokenize: text =>
        text
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .split(/[\s\p{P}\p{S}_]+/u)
          .filter(Boolean),
      searchOptions: {
        boost: { name: 3, serverId: 1.5, description: 1, parameters: 0.5 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR"
      }
    });
  }

  /** Add domain vocabulary (from server config) to the built-in synonym map. */
  public addSynonyms(extra: Record<string, string[]>): void {
    for (const [word, targets] of Object.entries(extra)) {
      const key = word.toLowerCase();
      this.synonyms[key] = Array.from(new Set([...(this.synonyms[key] ?? []), ...targets.map(t => t.toLowerCase())]));
    }
  }

  public registerTools(tools: DownstreamTool[]): void {
    const docs: IndexedToolDocument[] = [];
    for (const tool of tools) {
      if (this.toolRegistry.has(tool.namespacedName)) continue;
      this.toolRegistry.set(tool.namespacedName, tool);
      docs.push({
        id: tool.namespacedName,
        serverId: tool.serverId,
        name: tool.name,
        description: tool.description || "",
        parameters: Object.keys(tool.inputSchema?.properties || {}).join(" ")
      });
    }
    this.miniSearch.addAll(docs);
    this.prefixCache.clear();
  }

  /**
   * Query the index and return compact signatures for the top matches.
   * `minScore` is relative: matches scoring below minScore * best are dropped.
   */
  public search(
    query: string,
    maxResults = 5,
    minScore = 0,
    filter?: (tool: DownstreamTool) => boolean
  ): CompactToolSignature[] {
    const expanded = expandQuery(query, this.synonyms);
    const results = this.miniSearch.search(expanded, {
      filter: filter ? r => { const t = this.toolRegistry.get(r.id); return !!t && filter(t); } : undefined
    });
    if (results.length === 0) return [];

    // Re-rank: a tool whose own NAME words match the request beats one whose description
    // merely repeats a common word ("table" in every table tool). Server-wide name prefixes
    // ("ap_" on every tool) are ignored.
    const queryWords = new Set(expanded.split(/\s+/).filter(Boolean).map(singular));
    const ranked = results
      .map(r => {
        const tool = this.toolRegistry.get(r.id);
        const words = tool ? this.nameWords(tool) : [];
        const hits = words.filter(w => queryWords.has(w)).length;
        const coverage = words.length ? hits / words.length : 0;
        return { id: r.id, score: r.score * (1 + 0.6 * coverage) };
      })
      .sort((a, b) => b.score - a.score);
    const floor = ranked[0].score * minScore;

    return ranked
      .filter(r => r.score >= floor)
      .slice(0, maxResults)
      .map(match => this.toolRegistry.get(match.id))
      .filter((tool): tool is DownstreamTool => tool !== undefined)
      .map(tool => {
        const signatureText = SchemaTranspiler.transpileToTypeScript(tool);
        return {
          namespacedName: tool.namespacedName,
          signatureText,
          summary: summarizeDescription(tool.description),
          estimatedTokens: SchemaTranspiler.estimateTokens(signatureText)
        };
      });
  }

  /** Words of a tool name (singular), minus a prefix shared by most tools of its server. */
  private nameWords(tool: DownstreamTool): string[] {
    const words = tool.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
    const prefix = this.commonPrefix(tool.serverId);
    return prefix && words[0] === prefix ? words.slice(1) : words;
  }

  private prefixCache = new Map<string, string | undefined>();

  private commonPrefix(serverId: string): string | undefined {
    if (this.prefixCache.has(serverId)) return this.prefixCache.get(serverId);
    const firsts = [...this.toolRegistry.values()]
      .filter(t => t.serverId === serverId)
      .map(t => t.name.toLowerCase().split(/[^a-z0-9]+/)[0]);
    const counts = new Map<string, number>();
    for (const f of firsts) counts.set(f, (counts.get(f) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    const prefix = top && firsts.length >= 4 && top[1] / firsts.length >= 0.6 ? top[0] : undefined;
    this.prefixCache.set(serverId, prefix);
    return prefix;
  }

  public getTool(namespacedName: string): DownstreamTool | undefined {
    return this.toolRegistry.get(namespacedName);
  }

  public getAllTools(): DownstreamTool[] {
    return Array.from(this.toolRegistry.values());
  }
}

export function expandQuery(query: string, synonyms: Record<string, string[]> = SYNONYMS): string {
  const words = query.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  const extra = words.flatMap(w => synonyms[w] ?? []);
  return [...words, ...extra].join(" ");
}

/** First sentence of a description, capped at ~12 words, for compact search listings. */
export function summarizeDescription(description: string): string {
  const first = description.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const words = first.replace(/[.!?]$/, "").split(" ");
  return words.length > 12 ? `${words.slice(0, 12).join(" ")}…` : words.join(" ");
}
