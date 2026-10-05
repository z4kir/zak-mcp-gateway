import { DownstreamTool } from "../types/tool.js";

export type CatalogMode = "names" | "groups" | "servers" | "off";

/** Verbs that usually start or end a tool name; used to find tool families. */
const VERBS = new Set([
  "get", "list", "search", "read", "find", "describe", "query", "fetch", "show", "view", "count",
  "create", "update", "delete", "add", "remove", "set", "edit", "move", "merge", "fork", "push",
  "close", "reopen", "assign", "approve", "resolve", "submit", "cancel", "upload", "download",
  "run", "execute", "send", "post", "patch", "put", "insert", "upsert", "write", "lock", "unlock"
]);

/**
 * Tool index for the instructions, in one of four sizes:
 *   names   github: create_issue, list_issues, ...                 (every name)
 *   groups  github: {create,get,list,update}_issue ...            (tool families)
 *   servers github: 26 tools                                       (just the servers)
 *   off     nothing (the agent always searches)
 */
export function buildCatalog(tools: DownstreamTool[], mode: CatalogMode): string[] {
  if (mode === "off") return [];
  const byServer = new Map<string, DownstreamTool[]>();
  for (const t of tools) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    byServer.get(t.serverId)!.push(t);
  }

  const lines: string[] = [];
  for (const [server, list] of byServer) {
    const prefix = `${server} (prefix ${server}__)`;
    if (mode === "servers") {
      lines.push(`${prefix}: ${list.length} tools`);
    } else if (mode === "names") {
      lines.push(`${prefix}: ${list.map(t => t.name).join(", ")}`);
    } else {
      lines.push(`${prefix}: ${groupNames(list.map(t => t.name))}`);
    }
  }
  if (mode === "groups") {
    lines.push("{a,b}_x means a_x and b_x (plural forms are accepted).");
  }
  return lines;
}

/**
 * "create_issue, list_issues, get_issue, add_issue_comment, incident_create, incident_list"
 *   -> "{create,get,list}_issue add_issue_comment incident_{create,list}"
 * Families with a single member keep their exact name.
 */
export function groupNames(names: string[]): string {
  const families = new Map<string, { pos: "pre" | "post"; noun: string; members: { verb: string; name: string }[] }>();
  const loose: string[] = [];
  for (const name of names) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let fam: { pos: "pre" | "post"; noun: string; verb: string } | undefined;
    if (words.length > 1 && VERBS.has(words[0])) {
      fam = { pos: "pre", verb: words[0], noun: words.slice(1).map(singular).join("_") };
    } else if (words.length > 1 && VERBS.has(words[words.length - 1])) {
      fam = { pos: "post", verb: words[words.length - 1], noun: words.slice(0, -1).map(singular).join("_") };
    }
    if (!fam) {
      loose.push(name);
      continue;
    }
    const key = `${fam.pos}:${fam.noun}`;
    if (!families.has(key)) families.set(key, { pos: fam.pos, noun: fam.noun, members: [] });
    families.get(key)!.members.push({ verb: fam.verb, name });
  }
  const parts: string[] = [];
  for (const f of families.values()) {
    if (f.members.length === 1) {
      parts.push(f.members[0].name);
      continue;
    }
    const verbs = `{${[...new Set(f.members.map(m => m.verb))].sort().join(",")}}`;
    parts.push(f.pos === "pre" ? `${verbs}_${f.noun}` : `${f.noun}_${verbs}`);
  }
  return [...parts, ...loose].join(" ");
}

export function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}
