import { ResultStore } from "../results/result-store.js";
import { getPath } from "../util/json-path.js";

const HANDLE = /^r\d+$/;
const REF_KEYS = new Set(["$ref", "path", "replace"]);

interface Replacement {
  find: string;
  replace: string;
  all?: boolean;
}

/**
 * Handle references in arguments: any argument value of the form
 *   { "$ref": "r3", "path": "files[0].content", "replace": [{ "find": "old", "replace": "new" }] }
 * is replaced by the stored data before the call, so big data moves between tools (even
 * across servers) without passing through the model. Fails loudly: an unknown handle, a
 * missing path or an ambiguous patch never sends an empty or wrong value.
 */
export function resolveRefs(value: unknown, store: ResultStore): { value: unknown; refs: number } {
  let refs = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const obj = v as Record<string, unknown>;
    if (isRef(obj)) {
      refs++;
      return resolveOne(obj, store);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, walk(x)]));
  };
  return { value: walk(value), refs };
}

function isRef(obj: Record<string, unknown>): boolean {
  return typeof obj.$ref === "string" && HANDLE.test(obj.$ref) && Object.keys(obj).every(k => REF_KEYS.has(k));
}

function resolveOne(ref: Record<string, unknown>, store: ResultStore): unknown {
  const handle = String(ref.$ref);
  const entry = store.get(handle);
  if (!entry) throw new Error(`$ref ${handle} is unknown or expired; re-run the tool that produced it.`);

  let value: unknown;
  if (typeof ref.path === "string" && ref.path) {
    if (entry.json === undefined) throw new Error(`$ref ${handle} is plain text; it has no path "${ref.path}".`);
    const hit = getPath(entry.json, ref.path);
    if (!hit.found) throw new Error(`$ref ${handle}: path "${ref.path}" not found.`);
    value = hit.value;
  } else {
    value = entry.json !== undefined ? entry.json : entry.rawText;
  }

  if (Array.isArray(ref.replace) && ref.replace.length > 0) {
    if (typeof value !== "string") throw new Error(`$ref ${handle}: replace needs a text value (point path at a string field).`);
    value = applyReplacements(value, ref.replace as Replacement[], handle);
  }
  return value;
}

export function applyReplacements(text: string, edits: Replacement[], label = "text"): string {
  let out = text;
  edits.forEach((e, i) => {
    if (typeof e?.find !== "string" || e.find === "" || typeof e.replace !== "string") {
      throw new Error(`${label}: replace[${i}] needs non-empty "find" and a "replace" string.`);
    }
    const count = out.split(e.find).length - 1;
    if (count === 0) throw new Error(`${label}: replace[${i}] text not found: ${JSON.stringify(e.find.slice(0, 60))}`);
    if (count > 1 && !e.all) throw new Error(`${label}: replace[${i}] matches ${count} times; use a longer "find" or all: true.`);
    out = e.all ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace);
  });
  return out;
}
