/**
 * Offline token estimator (no tokenizer dependency). It splits text the way BPE tokenizers
 * roughly do: words (snake_case counts as one word), numbers in ~3-digit chunks, mixed
 * alphanumerics like SHAs/ids at ~2.5 chars per token, punctuation runs at ~3 chars per
 * token, and indentation runs.
 *
 * Calibrated against the o200k tokenizer on MCP schemas, GitHub API JSON, TSV and prose
 * (see tests/benchmark-github.mjs, which reports both). Used for gateway decisions
 * (inline vs handle) and the savings log, where consistency matters more than precision.
 */
const PIECE = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+|\n[ \t]+/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const m of text.matchAll(PIECE)) {
    const p = m[0];
    if (p[0] === "\n") tokens += 1;
    else if (/^[A-Za-z_]+$/.test(p)) tokens += Math.ceil(p.length / 6);
    else if (/^\d+$/.test(p)) tokens += Math.ceil(p.length / 3);
    else if (/^\w+$/.test(p)) tokens += Math.ceil(p.length / 2.5);
    else tokens += Math.ceil(p.length / 3);
  }
  return tokens;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value) ?? "");
}
