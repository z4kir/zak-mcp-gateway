import { DownstreamClientPool } from "../downstream/client-pool.js";
import { ExactMatchShaCache } from "../gate/sha-cache.js";
import { IdempotencyGuard } from "../gate/idempotency.js";
import { ProjectionFilter } from "../distiller/projection-filter.js";
import { NullPruner } from "../distiller/null-pruner.js";
import { ToolCallPayload } from "../types/tool.js";

/**
 * Execution Dispatcher:
 * Coordinates the full tool execution lifecycle:
 * 1. Cache hit evaluation (Decision Gate)
 * 2. Downstream routing via ClientPool
 * 3. Egress Distiller & Projection filtering
 * 4. Cache update
 */
export class ExecutionDispatcher {
  constructor(
    private clientPool: DownstreamClientPool,
    private cache: ExactMatchShaCache
  ) {}

  public async executeTool(payload: ToolCallPayload): Promise<unknown> {
    const { tool_name, arguments: args, project_fields } = payload;
    const tool = this.clientPool.getTool(tool_name);

    if (!tool) {
      throw new Error(`Tool "${tool_name}" not found. Try searching via "mcp_search_tools" first.`);
    }

    const isCacheable = IdempotencyGuard.isSafeToCache(tool_name, tool.isIdempotent);
    const cacheKey = ExactMatchShaCache.computeKey(tool_name, args);

    // 1. Check Tier-1 exact match cache
    if (isCacheable) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    // 2. Route downstream
    const client = this.clientPool.getClient(tool.serverId);
    if (!client) {
      throw new Error(`Downstream server "${tool.serverId}" is not connected.`);
    }

    const rawResponse = await client.callTool({
      name: tool.name,
      arguments: args
    });

    // 3. Egress Distiller & Projection Filter
    let processedResult = rawResponse;
    if (project_fields && project_fields.length > 0) {
      processedResult = ProjectionFilter.project(rawResponse, project_fields) as typeof rawResponse;
    }

    // 4. Null & empty pruning
    const cleanResult = NullPruner.prune(processedResult) ?? processedResult;

    // 5. Store in cache if idempotent
    if (isCacheable) {
      this.cache.set(cacheKey, cleanResult);
    }

    return cleanResult;
  }
}
