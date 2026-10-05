/**
 * Small JSON path used across the gateway (get one field, $ref arguments, patches,
 * group-by): dot segments, [index] and [key=value] filters.
 *
 *   files[0].content        items[name=readme].value        commit.author.name
 */
type Segment = { key: string } | { index: number } | { matchKey: string; matchValue: string };

const SEGMENT = /([^.[\]]+)|\[(\d+)\]|\[([^=\]]+)=([^\]]*)\]/g;

export function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const m of path.matchAll(SEGMENT)) {
    if (m[1] !== undefined) segments.push({ key: m[1] });
    else if (m[2] !== undefined) segments.push({ index: Number(m[2]) });
    else segments.push({ matchKey: m[3].trim(), matchValue: m[4].trim().replace(/^["']|["']$/g, "") });
  }
  return segments;
}

export function getPath(value: unknown, path: string): { found: boolean; value?: unknown } {
  if (!path) return { found: true, value };
  let current: unknown = value;
  for (const seg of parsePath(path)) {
    if ("key" in seg) {
      if (!current || typeof current !== "object" || !(seg.key in (current as Record<string, unknown>))) return { found: false };
      current = (current as Record<string, unknown>)[seg.key];
    } else if ("index" in seg) {
      if (!Array.isArray(current) || seg.index >= current.length) return { found: false };
      current = current[seg.index];
    } else {
      if (!Array.isArray(current)) return { found: false };
      const hit = current.find(
        item => item && typeof item === "object" && String((item as Record<string, unknown>)[seg.matchKey]) === seg.matchValue
      );
      if (hit === undefined) return { found: false };
      current = hit;
    }
  }
  return { found: true, value: current };
}
