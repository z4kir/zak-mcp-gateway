/**
 * Null and Empty Value Pruner:
 * Recursively eliminates nulls, undefined values, and empty objects/arrays from tool outputs
 * to eliminate syntactic bloat before passing back to LLM context. Returns undefined when
 * nothing is left.
 */
export class NullPruner {
  public static prune(data: unknown): unknown {
    if (data === null || data === undefined) {
      return undefined;
    }

    if (Array.isArray(data)) {
      const prunedArray = data
        .map(item => NullPruner.prune(item))
        .filter(item => item !== undefined);
      return prunedArray.length > 0 ? prunedArray : undefined;
    }

    if (typeof data === "object") {
      const res: Record<string, unknown> = {};
      let hasKeys = false;

      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const prunedVal = NullPruner.prune(value);
        if (prunedVal !== undefined) {
          res[key] = prunedVal;
          hasKeys = true;
        }
      }

      return hasKeys ? res : undefined;
    }

    return data;
  }
}
