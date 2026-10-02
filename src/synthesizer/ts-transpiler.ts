import { DownstreamTool, ToolParameterProperty } from "../types/tool.js";

/**
 * Schema Transpiler:
 * Converts verbose Draft-07 JSON Schemas into compact TypeScript operational signatures.
 * Example reduction: ~192 tokens -> ~36 tokens (~81% savings).
 */
export class SchemaTranspiler {
  /**
   * Transpile a tool definition into a compact TypeScript declaration.
   */
  public static transpileToTypeScript(tool: DownstreamTool): string {
    const params = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    
    const paramEntries = Object.entries(params).map(([paramName, paramProp]) => {
      const isReq = required.has(paramName);
      const tsType = this.resolveType(paramProp);
      return `${paramName}${isReq ? "" : "?"}: ${tsType}`;
    });

    const docComment = tool.description ? `// [${tool.serverId}] ${tool.description.trim()}\n` : "";
    const signature = `${tool.namespacedName}(\n  ${paramEntries.join(",\n  ")}\n): Promise<unknown>;`;

    return `${docComment}${signature}`;
  }

  private static resolveType(prop: ToolParameterProperty): string {
    if (prop.enum && prop.enum.length > 0) {
      return prop.enum.map(v => JSON.stringify(v)).join(" | ");
    }

    switch (prop.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "array":
        if (prop.items && typeof prop.items === "object") {
          return `${this.resolveType(prop.items as ToolParameterProperty)}[]`;
        }
        return "unknown[]";
      case "object":
        if (prop.properties) {
          const innerReq = new Set(prop.required || []);
          const inner = Object.entries(prop.properties)
            .map(([k, p]) => `${k}${innerReq.has(k) ? "" : "?"}: ${this.resolveType(p)}`)
            .join("; ");
          return `{ ${inner} }`;
        }
        return "Record<string, unknown>";
      default:
        return "unknown";
    }
  }

  /**
   * Fast rule-of-thumb token estimator (approx 4 chars per token).
   */
  public static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
