import * as crypto from "node:crypto";

interface CacheEntry<T> {
  result: T;
  timestamp: number;
  ttlMs: number;
}

/**
 * Tier-1 Decision Gate:
 * Computes deterministic SHA-256 hashes of (tool_name + arguments) to return 0-token,
 * 0-latency cached responses for identical idempotent calls.
 */
export class ExactMatchShaCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(private defaultTtlMs = 300_000) {}

  public static computeKey(toolName: string, args: unknown): string {
    const serialized = JSON.stringify({ toolName, args }, Object.keys(args as object || {}).sort());
    return crypto.createHash("sha256").update(serialized).digest("hex");
  }

  public get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result as T;
  }

  public set<T>(key: string, result: T, ttlMs = this.defaultTtlMs): void {
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      ttlMs
    });
  }

  public clear(): void {
    this.cache.clear();
  }
}
