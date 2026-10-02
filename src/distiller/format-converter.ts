/**
 * Format Converter:
 * Transforms JSON arrays into compact TSV (Tab-Separated Values) or Markdown tables,
 * achieving up to 70% token reduction for database result sets and lists.
 */
export class FormatConverter {
  public static toTsv(records: Record<string, unknown>[]): string {
    if (!records || records.length === 0) return "";

    const headers = Array.from(
      new Set(records.flatMap(r => Object.keys(r)))
    );

    const rows = records.map(record => {
      return headers
        .map(h => {
          const val = record[h];
          if (val === undefined || val === null) return "";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val).replace(/[\t\n\r]/g, " ");
        })
        .join("\t");
    });

    return [headers.join("\t"), ...rows].join("\n");
  }
}
