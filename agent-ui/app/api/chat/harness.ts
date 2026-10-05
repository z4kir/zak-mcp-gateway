import type { Content } from "@google/genai";

export const TRIM_OVER_CHARS = 600;

/** Shorten tool results from earlier turns; the latest results stay whole. */
export function trimHistory(history: Content[]): { history: Content[]; trimmed: number } {
  let trimmed = 0;
  const out = history.map(content => ({
    ...content,
    parts: content.parts?.map(part => {
      const resp = part.functionResponse?.response as Record<string, unknown> | undefined;
      const output = resp?.output;
      if (typeof output !== "string" || output.length <= TRIM_OVER_CHARS) return part;
      trimmed++;
      const handle = output.match(/\[(r\d+)[:\s]/)?.[1];
      const note = handle ? `…[trimmed old result; full data: mcp_get_result handle ${handle}]` : "…[trimmed old result; call the tool again if needed]";
      return { ...part, functionResponse: { ...part.functionResponse, response: { ...resp, output: `${output.slice(0, 300)}${note}` } } };
    })
  }));
  return { history: out, trimmed };
}

/** Values in the answer that look like facts (SHAs, ids, long numbers) but appear in no tool result. */
export function unverifiedValues(answer: string, evidence: string): string[] {
  const candidates = new Set([
    ...(answer.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter(x => /\d/.test(x) && /[a-f]/.test(x)),
    ...(answer.match(/#\d{2,}/g) ?? []).map(x => x.slice(1)),
    ...(answer.match(/\b[A-Z]{2,10}-?\d{3,}\b/g) ?? []),
    ...(answer.match(/\b\d{5,}\b/g) ?? [])
  ]);
  const hay = evidence.toLowerCase();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = (v: string) => {
    const value = escape(v.toLowerCase());
    // Whole tokens only ("1234" is not found inside "INC0012345"); a short SHA may be the
    // prefix of a full one.
    const isHex = /^[0-9a-f]+$/.test(v.toLowerCase()) && /[a-f]/.test(v.toLowerCase());
    const re = isHex ? new RegExp(`(^|[^0-9a-z])${value}`) : new RegExp(`(^|[^0-9a-z])${value}($|[^0-9a-z])`);
    return re.test(hay);
  };
  return [...candidates].filter(v => !found(v)).slice(0, 10);
}

