import { DownstreamTool, ToolInputSchema, ToolParameterProperty } from "../types/tool.js";
import { estimateTokens } from "../util/tokens.js";

const MAX_TOOL_DESCRIPTION = 400;
const MAX_PARAM_NOTE = 90;
const MAX_INLINE_DEPTH = 4;

class TooComplexError extends Error {}

/**
 * Schema Transpiler:
 * Converts verbose JSON Schemas into compact TypeScript-style call signatures, e.g.
 *
 *   // [github] Get list of commits of a branch in a GitHub repository
 *   github__list_commits({ owner: string, repo: string, sha?: string, page?: number, perPage?: number })
 *
 * Parameter descriptions survive as short trailing comments, because dropping them hurts
 * tool-call accuracy. Schemas that cannot be shortened safely ($ref, deep nesting) fall
 * back to the full minified JSON Schema.
 */
export class SchemaTranspiler {
  public static transpileToTypeScript(tool: DownstreamTool): string {
    const header = tool.description
      ? `// [${tool.serverId}] ${clip(collapse(tool.description), MAX_TOOL_DESCRIPTION)}\n`
      : `// [${tool.serverId}]\n`;

    try {
      const params = this.renderParams(tool.inputSchema);
      const returns = tool.outputSchema ? `: ${this.resolveType(tool.outputSchema as ToolParameterProperty, 0)}` : "";
      return `${header}${tool.namespacedName}(${params})${returns}`;
    } catch (err) {
      if (!(err instanceof TooComplexError)) throw err;
      return `${header}${tool.namespacedName}(args) // args JSON Schema: ${JSON.stringify(this.minifySchema(tool.inputSchema))}`;
    }
  }

  private static renderParams(schema: ToolInputSchema | undefined): string {
    const props = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);
    const entries = Object.entries(props);
    if (entries.length === 0) return "{}";

    const lines = entries.map(([name, prop]) => {
      const opt = required.has(name) ? "" : "?";
      const type = this.resolveType(prop, 1);
      const def = prop.default !== undefined ? ` = ${JSON.stringify(prop.default)}` : "";
      return { code: `${safeKey(name)}${opt}: ${type}${def}`, note: this.paramNote(prop) };
    });

    if (lines.every(l => !l.note)) {
      return `{ ${lines.map(l => l.code).join(", ")} }`;
    }
    return `{\n${lines.map(l => `  ${l.code},${l.note ? ` // ${l.note}` : ""}`).join("\n")}\n}`;
  }

  private static paramNote(prop: ToolParameterProperty): string {
    const parts: string[] = [];
    if (typeof prop.description === "string" && prop.description.trim()) {
      parts.push(clip(collapse(prop.description), MAX_PARAM_NOTE));
    }
    const min = prop.minimum ?? prop.minLength ?? prop.minItems;
    const max = prop.maximum ?? prop.maxLength ?? prop.maxItems;
    if (min !== undefined || max !== undefined) parts.push(`${min ?? ""}..${max ?? ""}`);
    if (typeof prop.format === "string") parts.push(prop.format);
    return parts.join("; ");
  }

  public static resolveType(prop: ToolParameterProperty | undefined, depth: number): string {
    if (!prop || typeof prop !== "object") return "any";
    if (depth > MAX_INLINE_DEPTH || prop.$ref) throw new TooComplexError();

    if (prop.const !== undefined) return JSON.stringify(prop.const);
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      return prop.enum.map(v => JSON.stringify(v)).join(" | ");
    }

    const variants = prop.anyOf ?? prop.oneOf;
    if (Array.isArray(variants) && variants.length > 0) {
      return unique(variants.map(v => this.resolveType(v, depth + 1))).join(" | ");
    }
    if (Array.isArray(prop.allOf) && prop.allOf.length > 0) {
      const merged: ToolParameterProperty = { type: "object", properties: {}, required: [] };
      for (const part of prop.allOf) {
        if (part.$ref) throw new TooComplexError();
        Object.assign(merged.properties!, part.properties ?? {});
        merged.required!.push(...(part.required ?? []));
      }
      return this.resolveType(merged, depth);
    }

    if (Array.isArray(prop.type)) {
      return unique(prop.type.map(t => this.resolveType({ ...prop, type: t }, depth))).join(" | ");
    }

    const nullable = prop.nullable === true ? " | null" : "";
    switch (prop.type) {
      case "string":
        return "string" + nullable;
      case "number":
      case "integer":
        return "number" + nullable;
      case "boolean":
        return "boolean" + nullable;
      case "null":
        return "null";
      case "array": {
        const items = Array.isArray(prop.items) ? { anyOf: prop.items } : prop.items;
        const inner = items ? this.resolveType(items, depth + 1) : "any";
        return (inner.includes("|") ? `(${inner})[]` : `${inner}[]`) + nullable;
      }
      case "object":
      case undefined: {
        if (prop.properties && Object.keys(prop.properties).length > 0) {
          const req = new Set(prop.required ?? []);
          const inner = Object.entries(prop.properties)
            .map(([k, p]) => `${safeKey(k)}${req.has(k) ? "" : "?"}: ${this.resolveType(p, depth + 1)}`)
            .join("; ");
          return `{ ${inner} }` + nullable;
        }
        if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
          return `Record<string, ${this.resolveType(prop.additionalProperties as ToolParameterProperty, depth + 1)}>` + nullable;
        }
        return (prop.type === "object" ? "object" : "any") + nullable;
      }
      default:
        return "any";
    }
  }

  /** Strip keys that carry no meaning for the model ($schema, additionalProperties:false, ...). */
  public static minifySchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(s => this.minifySchema(s));
    if (!schema || typeof schema !== "object") return schema;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "$schema" || k === "title" || (k === "additionalProperties" && v === false)) continue;
      out[k] = this.minifySchema(v);
    }
    return out;
  }

  public static estimateTokens(text: string): number {
    return estimateTokens(text);
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}
