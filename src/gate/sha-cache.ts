import * as crypto from "node:crypto";

interface CacheEntry<T> {
  result: T;
  serverId: string;
  expiresAt: number;
}

/** JSON.stringify with recursively sorted object keys, so {a,b} and {b,a} hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Tier-1 Decision Gate:
 * SHA-256 of (tool name + canonical arguments) -> cached downstream result, for read-only
 * tools only. Bounded LRU with TTL. Any write on a server invalidates that server's entries,
 * so a read after a write never returns stale data.
 */
export class ExactMatchShaCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private defaultTtlMs = 300_000,
    private maxEntries = 1000
  ) {}

  public static computeKey(toolName: string, args: unknown): string {
    return crypto.createHash("sha256").update(stableStringify({ toolName, args: args ?? {} })).digest("hex");
  }

  public get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result as T;
  }

  public set<T>(key: string, result: T, serverId = "", ttlMs = this.defaultTtlMs): void {
    this.cache.delete(key);
    this.cache.set(key, { result, serverId, expiresAt: Date.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  public invalidateServer(serverId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.serverId === serverId) this.cache.delete(key);
    }
  }

  public get size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }
}
