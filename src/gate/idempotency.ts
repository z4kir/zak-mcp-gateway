/**
 * Evaluates whether a tool execution is idempotent and safe for caching.
 */
export class IdempotencyGuard {
  private static readonly MUTATION_PREFIXES = [
    "create",
    "update",
    "delete",
    "post",
    "insert",
    "patch",
    "remove",
    "drop",
    "send",
    "write",
    "modify"
  ];

  /**
   * Determine if a tool is safe to cache.
   */
  public static isSafeToCache(toolName: string, explicitIdempotent?: boolean): boolean {
    if (explicitIdempotent !== undefined) {
      return explicitIdempotent;
    }

    const lower = toolName.toLowerCase();
    const simpleName = lower.includes("::") ? lower.split("::")[1] : lower;

    // If starts with mutating verb, do not cache
    for (const prefix of this.MUTATION_PREFIXES) {
      if (simpleName.startsWith(prefix)) {
        return false;
      }
    }

    // Default to caching for read queries (get, list, search, read, find, describe, inspect)
    return true;
  }
}
