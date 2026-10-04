import { estimateTokens } from "../util/tokens.js";

type Row = Record<string, unknown>;

/**
 * Format Converter:
 * Renders arrays of objects as TSV (one header line, then one line per row) instead of
 * JSON, which repeats every key name on every row. Nested objects are flattened to dotted
 * column names ("commit.author.name"). The caller keeps whichever rendering is smaller.
 */
export class FormatConverter {
  public static isTabular(value: unknown): value is Row[] {
    return (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.every(v => v !== null && typeof v === "object" && !Array.isArray(v))
    );
  }

  public static toTsv(records: Row[]): string {
    if (!records || records.length === 0) return "";
    const flat = records.map(r => this.flatten(r));
    const headers = Array.from(new Set(flat.flatMap(r => Object.keys(r))));
    const rows = flat.map(record => headers.map(h => this.cell(record[h])).join("\t"));
    return [headers.join("\t"), ...rows].join("\n");
  }

  /**
   * Compact JSON or TSV, whichever costs fewer tokens. A wrapper like
   * {total_count: 3, items: [...]} renders as one meta line plus a TSV table.
   */
  public static render(value: unknown, allowTsv = true): string {
    if (typeof value === "string") return value;
    const json = JSON.stringify(value) ?? "";
    if (!allowTsv) return json;

    let tsv: string | undefined;
    if (this.isTabular(value)) {
      tsv = this.toTsv(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Row);
      const tables = entries.filter(([, v]) => this.isTabular(v));
      const rest = entries.filter(([, v]) => !this.isTabular(v));
      if (tables.length === 1 && rest.every(([, v]) => v === null || typeof v !== "object")) {
        const [key, rows] = tables[0];
        const meta = rest.length ? `${JSON.stringify(Object.fromEntries(rest))}\n` : "";
        tsv = `${meta}${key}:\n${this.toTsv(rows as Row[])}`;
      }
    }
    return tsv !== undefined && estimateTokens(tsv) < estimateTokens(json) ? tsv : json;
  }

  private static flatten(obj: Row, prefix = "", depth = 0, out: Row = {}): Row {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) {
        this.flatten(v as Row, key, depth + 1, out);
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  private static cell(val: unknown): string {
    if (val === undefined || val === null) return "";
    if (Array.isArray(val) && val.every(v => v === null || typeof v !== "object")) {
      return val.join(",").replace(/[\t\n\r]+/g, " ");
    }
    if (typeof val === "object") return JSON.stringify(val).replace(/[\t\n\r]+/g, " ");
    return String(val).replace(/[\t\n\r]+/g, " ");
  }
}
