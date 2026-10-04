import { matchesAny } from "../util/glob.js";

export interface KeyFilterResult {
  value: unknown;
  droppedKeys: number;
  clippedStrings: number;
}

/**
 * Noise Filter:
 * Recursively drops keys matching noise patterns (hypermedia "*_url" links, node_id, ...)
 * and clips very long strings. Both are lossy for the inline view only: the gateway keeps
 * the untouched result behind a handle (mcp_get_result).
 */
export class KeyFilter {
  public static apply(
    data: unknown,
    dropKeys: string[],
    keepKeys: string[],
    maxStringChars: number
  ): KeyFilterResult {
    const stats = { droppedKeys: 0, clippedStrings: 0 };
    const decisions = new Map<string, boolean>();
    const shouldDrop = (key: string): boolean => {
      let d = decisions.get(key);
      if (d === undefined) {
        d = matchesAny(key, dropKeys) && !matchesAny(key, keepKeys);
        decisions.set(key, d);
      }
      return d;
    };

    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (value.length > maxStringChars) {
          stats.clippedStrings++;
          return `${value.slice(0, maxStringChars)}…[+${value.length - maxStringChars} chars]`;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (shouldDrop(k)) {
            stats.droppedKeys++;
            continue;
          }
          out[k] = walk(v);
        }
        return out;
      }
      return value;
    };

    return { value: walk(data), ...stats };
  }
}
