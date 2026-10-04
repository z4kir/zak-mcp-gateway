export interface StoredResult {
  handle: string;
  toolName: string;
  serverId: string;
  /** Original text exactly as the downstream server returned it. */
  rawText: string;
  /** Parsed JSON, when the text was JSON. */
  json?: unknown;
  createdAt: number;
}

/**
 * Result Store:
 * Keeps full tool results inside the gateway (bounded LRU) so the model can receive a short
 * preview plus a handle like "r3", then page / grep / project only what it needs.
 */
export class ResultStore {
  private results = new Map<string, StoredResult>();
  private counter = 0;

  constructor(private maxStored = 50) {}

  public put(entry: Omit<StoredResult, "handle" | "createdAt">): string {
    const handle = `r${++this.counter}`;
    this.results.set(handle, { ...entry, handle, createdAt: Date.now() });
    while (this.results.size > this.maxStored) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
    return handle;
  }

  public get(handle: string): StoredResult | undefined {
    return this.results.get(handle.trim());
  }

  public get size(): number {
    return this.results.size;
  }
}
