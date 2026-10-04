import { ToolAccess, ToolAnnotations } from "../types/tool.js";

/** Verbs that only read. A tool is "read" only if its name contains one and no write verb. */
const READ_VERBS = new Set([
  "get", "list", "search", "read", "find", "describe", "query", "fetch", "show", "view",
  "count", "inspect", "lookup", "status", "info", "tree", "diff", "explain"
]);

/** Verbs that change state. Their presence anywhere in the name makes the tool "write". */
const WRITE_VERBS = new Set([
  "create", "update", "delete", "post", "insert", "patch", "remove", "drop", "send", "write",
  "modify", "push", "fork", "merge", "add", "set", "edit", "move", "upload", "execute", "run",
  "close", "reopen", "assign", "approve", "comment", "publish", "rename", "archive", "revoke",
  "grant", "invite", "lock", "unlock", "dismiss", "submit", "cancel", "trigger", "deploy",
  "restore", "reset", "truncate", "alter", "upsert", "replace", "put", "mkdir", "rm", "kill"
]);

/**
 * Decides whether a downstream tool is read-only (safe to cache, allowed in read-only mode)
 * or a write. Order of evidence:
 *   1. MCP annotations (`readOnlyHint`), which servers set explicitly
 *   2. Verb analysis of the tool name (snake_case, kebab-case and camelCase)
 *   3. Unknown -> "write" (the safe default: never cached, needs confirmation)
 */
export class IdempotencyGuard {
  public static classify(toolName: string, annotations?: ToolAnnotations): ToolAccess {
    if (annotations?.readOnlyHint === true) return "read";
    if (annotations?.readOnlyHint === false) return "write";

    const words = toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    if (words.some(w => WRITE_VERBS.has(w))) return "write";
    if (words.some(w => READ_VERBS.has(w))) return "read";
    return "write";
  }

  /** Back-compat helper: is this tool safe to serve from the exact-match cache? */
  public static isSafeToCache(toolName: string, annotations?: ToolAnnotations): boolean {
    return this.classify(toolName, annotations) === "read";
  }
}
