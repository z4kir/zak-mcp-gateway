import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { log } from "../util/log.js";

export interface SessionRecord {
  type: "session";
  ts: string;
  session: string;
  servers: string[];
  toolCount: number;
  /** tools/list tokens a client would see connecting to every server directly. */
  baselineSchemaTokens: number;
  /** tools/list + instructions tokens the client sees through the gateway. */
  gatewaySchemaTokens: number;
}

export interface CallRecord {
  type: "call";
  ts: string;
  session: string;
  /** Meta-tool used: call | search | get_result | run_code | pinned */
  via: string;
  tool: string;
  /** Tokens the downstream result would have cost without the gateway (0 for gateway-only overhead like search). */
  rawTokens: number;
  /** Tokens actually returned to the model. */
  sentTokens: number;
  cacheHit: boolean;
  blocked?: string;
  ms: number;
}

export type StatsRecord = SessionRecord | CallRecord;

export interface StatsSummary {
  session: string;
  calls: number;
  cacheHits: number;
  blocked: number;
  rawTokens: number;
  sentTokens: number;
  savedTokens: number;
  savedPct: number;
  baselineSchemaTokens: number;
  gatewaySchemaTokens: number;
  budget: number;
  budgetUsedPct: number;
}

/**
 * Savings tracker: logs every call as one JSONL line so reports can be recomputed from the
 * log, and enforces the optional per-session token budget.
 */
export class TokenStats {
  public readonly session = crypto.randomUUID().slice(0, 8);
  private records: StatsRecord[] = [];
  private logPath?: string;

  constructor(
    private enabled: boolean,
    logFile: string,
    configDir: string,
    private budget = 0
  ) {
    if (enabled) {
      this.logPath = path.resolve(configDir, logFile);
      try {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      } catch (err) {
        log.warn(`[stats] cannot create log dir: ${(err as Error).message}`);
        this.logPath = undefined;
      }
    }
  }

  public recordSession(r: Omit<SessionRecord, "type" | "ts" | "session">): void {
    this.write({ type: "session", ts: new Date().toISOString(), session: this.session, ...r });
  }

  public recordCall(r: Omit<CallRecord, "type" | "ts" | "session">): void {
    this.write({ type: "call", ts: new Date().toISOString(), session: this.session, ...r });
  }

  /** Fraction of the session budget used (0 when no budget is set). */
  public budgetRatio(): number {
    if (!this.budget) return 0;
    return this.sentTokens() / this.budget;
  }

  public summary(): StatsSummary {
    return summarize(this.records, this.session, this.budget);
  }

  private sentTokens(): number {
    let sum = 0;
    for (const r of this.records) if (r.type === "call") sum += r.sentTokens;
    return sum;
  }

  private write(record: StatsRecord): void {
    this.records.push(record);
    if (!this.enabled || !this.logPath) return;
    fs.appendFile(this.logPath, JSON.stringify(record) + "\n", err => {
      if (err) log.warn(`[stats] write failed: ${err.message}`);
    });
  }
}

export function summarize(records: StatsRecord[], session: string, budget = 0): StatsSummary {
  const calls = records.filter((r): r is CallRecord => r.type === "call" && r.session === session);
  const sess = records.find((r): r is SessionRecord => r.type === "session" && r.session === session);
  const rawTokens = calls.reduce((s, c) => s + c.rawTokens, 0);
  const sentTokens = calls.reduce((s, c) => s + c.sentTokens, 0);
  const saved = rawTokens - sentTokens;
  return {
    session,
    calls: calls.length,
    cacheHits: calls.filter(c => c.cacheHit).length,
    blocked: calls.filter(c => c.blocked).length,
    rawTokens,
    sentTokens,
    savedTokens: saved,
    savedPct: rawTokens ? Math.round((saved / rawTokens) * 1000) / 10 : 0,
    baselineSchemaTokens: sess?.baselineSchemaTokens ?? 0,
    gatewaySchemaTokens: sess?.gatewaySchemaTokens ?? 0,
    budget,
    budgetUsedPct: budget ? Math.round((sentTokens / budget) * 1000) / 10 : 0
  };
}
