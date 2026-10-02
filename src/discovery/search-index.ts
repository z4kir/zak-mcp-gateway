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

/**
 * JIT Tool Discovery Engine:
 * Indexes all tools across downstream MCP servers and provides sub-millisecond
 * search retrieval so the LLM prompt only receives relevant tools.
 */
export class ToolDiscoveryEngine {
  private miniSearch: MiniSearch<IndexedToolDocument>;
  private toolRegistry = new Map<string, DownstreamTool>();

  constructor() {
    this.miniSearch = new MiniSearch<IndexedToolDocument>({
      fields: ["name", "description", "serverId", "parameters"],
      storeFields: ["id", "serverId", "name"],
      searchOptions: {
        boost: { name: 2, description: 1 },
        fuzzy: 0.2,
        prefix: true
      }
    });
  }

  /**
   * Register and index a batch of tools from a downstream server.
   */
  public registerTools(tools: DownstreamTool[]): void {
    const docs: IndexedToolDocument[] = [];

    for (const tool of tools) {
      this.toolRegistry.set(tool.namespacedName, tool);

      const paramNames = Object.keys(tool.inputSchema?.properties || {}).join(" ");
      docs.push({
        id: tool.namespacedName,
        serverId: tool.serverId,
        name: tool.name,
        description: tool.description || "",
        parameters: paramNames
      });
    }

    this.miniSearch.addAll(docs);
  }

  /**
   * Query the index and return compact TypeScript signatures for top matching tools.
   */
  public search(query: string, maxResults = 5): CompactToolSignature[] {
    const results = this.miniSearch.search(query);
    const topMatches = results.slice(0, maxResults);

    return topMatches
      .map(match => {
        const tool = this.toolRegistry.get(match.id);
        if (!tool) return null;

        const signatureText = SchemaTranspiler.transpileToTypeScript(tool);
        return {
          namespacedName: tool.namespacedName,
          signatureText,
          estimatedTokens: SchemaTranspiler.estimateTokens(signatureText)
        };
      })
      .filter((item): item is CompactToolSignature => item !== null);
  }

  public getTool(namespacedName: string): DownstreamTool | undefined {
    return this.toolRegistry.get(namespacedName);
  }

  public getAllTools(): DownstreamTool[] {
    return Array.from(this.toolRegistry.values());
  }
}
