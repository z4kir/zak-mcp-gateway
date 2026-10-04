import MiniSearch from "minisearch";
import { DownstreamTool, CompactToolSignature } from "../types/tool.js";
import { SchemaTranspiler } from "../synthesizer/ts-transpiler.js";

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
  people: ["users"]
};

/**
 * JIT Tool Discovery Engine:
 * BM25 (MiniSearch) over tool names, descriptions and parameter names, with fuzzy + prefix
 * matching and a small synonym map. Returns compact signatures for the best matches only.
 */
export class ToolDiscoveryEngine {
  private miniSearch: MiniSearch<IndexedToolDocument>;
  private toolRegistry = new Map<string, DownstreamTool>();

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
    const expanded = expandQuery(query);
    const results = this.miniSearch.search(expanded, {
      filter: filter ? r => { const t = this.toolRegistry.get(r.id); return !!t && filter(t); } : undefined
    });
    if (results.length === 0) return [];
    const floor = results[0].score * minScore;

    return results
      .filter(r => r.score >= floor)
      .slice(0, maxResults)
      .map(match => this.toolRegistry.get(match.id))
      .filter((tool): tool is DownstreamTool => tool !== undefined)
      .map(tool => {
        const signatureText = SchemaTranspiler.transpileToTypeScript(tool);
        return {
          namespacedName: tool.namespacedName,
          signatureText,
          estimatedTokens: SchemaTranspiler.estimateTokens(signatureText)
        };
      });
  }

  public getTool(namespacedName: string): DownstreamTool | undefined {
    return this.toolRegistry.get(namespacedName);
  }

  public getAllTools(): DownstreamTool[] {
    return Array.from(this.toolRegistry.values());
  }
}

export function expandQuery(query: string): string {
  const words = query.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  const extra = words.flatMap(w => SYNONYMS[w] ?? []);
  return [...words, ...extra].join(" ");
}
