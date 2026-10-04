import { DownstreamTool, ToolParameterProperty } from "../types/tool.js";

export interface ArgCheck {
  args: Record<string, unknown>;
  /** Automatic, meaning-preserving repairs that were applied (reported to the model). */
  fixes: string[];
  /** Problems that block the call. */
  errors: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, "");

/**
 * Validate-before-dispatch:
 * Catches the common LLM argument mistakes locally instead of paying for a downstream
 * round trip (or, worse, a silently ignored parameter):
 *   - arguments sent as a JSON string
 *   - near-miss names: per_page vs perPage, Owner vs owner
 *   - numbers / booleans sent as strings
 *   - missing required parameters and unknown parameters (when the schema forbids extras)
 */
export function validateArgs(tool: DownstreamTool, input: unknown): ArgCheck {
  const fixes: string[] = [];
  const errors: string[] = [];

  let args: Record<string, unknown> = {};
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
      fixes.push("parsed arguments from a JSON string");
    } catch {
      return { args: {}, fixes, errors: ["arguments must be an object"] };
    }
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    args = { ...(input as Record<string, unknown>) };
  }

  const props = tool.inputSchema?.properties ?? {};
  const propNames = Object.keys(props);
  const byNorm = new Map(propNames.map(p => [norm(p), p]));
  const closed = tool.inputSchema?.additionalProperties === false;

  for (const key of Object.keys(args)) {
    if (key in props) continue;
    const target = byNorm.get(norm(key));
    if (target && !(target in args)) {
      args[target] = args[key];
      delete args[key];
      fixes.push(`renamed "${key}" to "${target}"`);
    } else if (closed && propNames.length > 0) {
      errors.push(`unknown parameter "${key}"`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const coerced = coerce(value, props[key]);
    if (coerced !== value) {
      args[key] = coerced;
      fixes.push(`converted "${key}" to ${typeof coerced}`);
    }
  }

  for (const req of tool.inputSchema?.required ?? []) {
    if (args[req] === undefined || args[req] === null) errors.push(`missing required "${req}"`);
  }

  return { args, fixes, errors };
}

function coerce(value: unknown, prop: ToolParameterProperty | undefined): unknown {
  if (!prop || typeof value !== "string") return value;
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  if (types.includes("string")) return value;
  if ((types.includes("number") || types.includes("integer")) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  if (types.includes("boolean") && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  if ((types.includes("array") || types.includes("object")) && /^[[{]/.test(value.trim())) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
