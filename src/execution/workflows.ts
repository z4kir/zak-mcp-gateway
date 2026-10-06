import { WorkflowConfig } from "../config/schema.js";
import { DownstreamTool, ToolResult } from "../types/tool.js";
import { getPath } from "../util/json-path.js";
import { estimateTokens } from "../util/tokens.js";
import { log } from "../util/log.js";
import { validateArgs } from "./arg-validator.js";
import { ExecutionDispatcher } from "./dispatcher.js";
import { FormatConverter } from "../distiller/format-converter.js";

export const WORKFLOW_PREFIX = "wf__";

const TEMPLATE = /\$\{([^}]+)\}/g;
const WHOLE_TEMPLATE = /^\$\{([^}]+)\}$/;

interface Scope {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  item?: unknown;
}

/**
 * Workflow tools: a named, configured sequence of tool calls the agent runs in ONE turn.
 *
 *   "build_table": {
 *     "description": "Create a table with columns. Not for editing existing tables.",
 *     "input": { "properties": { "table": {"type":"string"}, "columns": {"type":"array"} }, "required": ["table"] },
 *     "steps": [
 *       { "id": "table", "tool": "lean__create_table", "arguments": { "name": "${input.table}" } },
 *       { "tool": "lean__create_column", "forEach": "${input.columns}", "arguments": { "table": "${steps.table.id}", "name": "${item}" } }
 *     ]
 *   }
 *
 * Every step goes through the dispatcher's normal checks (policy, write confirmation,
 * validation, cache). Writes need one confirmation for the whole workflow. It stops at the
 * first failure and reports exactly what ran; every step's full reply stays behind a handle.
 */
export class WorkflowRunner {
  private workflows = new Map<string, WorkflowConfig>();

  constructor(
    configs: Record<string, WorkflowConfig>,
    private dispatcher: ExecutionDispatcher,
    toolExists: (name: string) => boolean
  ) {
    for (const [name, wf] of Object.entries(configs)) {
      const missing = wf.steps.map(s => s.tool).filter(t => !toolExists(t));
      if (missing.length) {
        log.error(`[workflow] "${name}" disabled: unknown tools ${[...new Set(missing)].join(", ")}`);
        continue;
      }
      this.workflows.set(name, wf);
    }
    if (this.workflows.size) log.info(`[workflow] ${this.workflows.size} workflows ready`);
  }

  /** Workflows as catalog/search entries, so they are listed and found like tools. */
  public asTools(): DownstreamTool[] {
    return [...this.workflows].map(([name, wf]) => ({
      serverId: "wf",
      name,
      namespacedName: `${WORKFLOW_PREFIX}${name}`,
      description: `${wf.description} (workflow: ${wf.steps.length} steps in one call)`,
      inputSchema: { type: "object", properties: wf.input.properties as never, required: wf.input.required },
      access: this.hasWrites(wf) ? "write" : "read"
    }));
  }

  public resolve(name: string): { name: string; wf: WorkflowConfig } | undefined {
    const bare = name.trim().replace(/^wf(__|::|\.|\/)/, "");
    const wf = this.workflows.get(bare);
    return wf ? { name: bare, wf } : undefined;
  }

  private hasWrites(wf: WorkflowConfig): boolean {
    return wf.steps.some(s => this.dispatcher.staticAccess(s.tool) === "write");
  }

  public async run(name: string, input: unknown, confirm: boolean): Promise<{ result: ToolResult; rawTokens: number }> {
    const found = this.resolve(name);
    if (!found) return { result: fail(`Unknown workflow "${name}".`), rawTokens: 0 };
    const { wf } = found;
    const tag = `${WORKFLOW_PREFIX}${found.name}`;

    const check = validateArgs(
      { serverId: "wf", name: found.name, namespacedName: tag, description: wf.description, access: "read", inputSchema: { type: "object", properties: wf.input.properties as never, required: wf.input.required } },
      input
    );
    if (check.errors.length) return { result: fail(`Invalid input for ${tag}: ${check.errors.join("; ")}.`), rawTokens: 0 };

    // One confirmation for the whole workflow, shown as a preview before anything runs.
    if (!confirm && this.hasWrites(wf) && this.dispatcher.needsConfirmation()) {
      const plan = wf.steps.map((s, i) => `${i + 1}. ${s.tool}${s.forEach ? ` for each of ${s.forEach}` : ""}${this.dispatcher.staticAccess(s.tool) === "write" ? " (changes data)" : ""}`);
      return {
        result: fail(`${tag} changes data. Steps:\n${plan.join("\n")}\nConfirm with the user, then call ${tag} again with "confirm": true.`),
        rawTokens: 0
      };
    }

    const scope: Scope = { input: check.args, steps: {} };
    // What the model may see of each step (projected, de-noised); arguments use full values.
    const views: Record<string, unknown> = {};
    const lines: string[] = [];
    let rawTokens = 0;

    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      const label = `${i + 1}${step.id ? ` ${step.id}` : ""}`;
      try {
        const items = step.forEach ? render(step.forEach, scope, true) : [undefined];
        if (!Array.isArray(items)) throw new Error(`forEach ${step.forEach} is not a list`);
        const values: unknown[] = [];
        const handles: string[] = [];
        for (const item of items) {
          const args = render(step.arguments, { ...scope, item }, true);
          const r = await this.dispatcher.callRaw(step.tool, args, { confirm, via: "workflow_step" });
          rawTokens += r.rawTokens;
          values.push(r.value);
          handles.push(r.handle);
        }
        const value = step.forEach ? values : values[0];
        if (step.id) {
          scope.steps[step.id] = value;
          views[step.id] = step.forEach
            ? values.map(v => this.dispatcher.viewOf(step.tool, v, step.fields))
            : this.dispatcher.viewOf(step.tool, value, step.fields);
        }
        const report = step.report.length
          ? ` ${JSON.stringify(Object.fromEntries(step.report.map(p => [p, step.forEach ? values.map(v => getPath(v, p).value) : getPath(value, p).value])))}`
          : "";
        const h = handles.length > 1 ? `${handles[0]}..${handles[handles.length - 1]}` : handles[0] ?? "-";
        lines.push(`${label} ${step.tool}${step.forEach ? ` ×${items.length}` : ""} ok${report} [${h}]`);
      } catch (err) {
        const done = i === 0 ? "nothing ran" : `steps 1-${i} done`;
        const rest = i < wf.steps.length - 1 ? `; steps ${i + 2}-${wf.steps.length} not run` : "";
        lines.push(`${label} ${step.tool} FAILED: ${(err as Error).message}`);
        return { result: fail(`${tag} stopped at step ${i + 1} (${done}${rest}).\n${lines.join("\n")}`), rawTokens };
      }
    }

    let output = "";
    if (wf.output) {
      try {
        // The output sees the trimmed views, so it is as small as normal tool replies.
        const rendered = render(wf.output, { ...scope, steps: views }, false);
        output = `\noutput: ${FormatConverter.render(rendered)}`;
      } catch (err) {
        output = `\noutput: (could not build: ${(err as Error).message})`;
      }
    }
    const summary: ToolResult = { content: [{ type: "text", text: `${tag} ok (${wf.steps.length} steps)\n${lines.join("\n")}${output}` }] };
    // Same size limits as any reply: a big summary becomes a preview + handle.
    return { result: this.dispatcher.distillReply(summary, tag), rawTokens };
  }
}

/**
 * Fill ${input.x} / ${steps.id.path} / ${item.x} templates. A string that is exactly one
 * template keeps the value's type (lists, numbers, objects); embedded templates become text.
 * A missing value throws (strict) so a step never runs with an empty argument.
 */
export function render(value: unknown, scope: Scope, strict: boolean): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_TEMPLATE);
    if (whole) return lookup(whole[1].trim(), scope, strict);
    return value.replace(TEMPLATE, (_m, expr: string) => {
      const v = lookup(expr.trim(), scope, strict);
      return v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => render(v, scope, strict));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, render(v, scope, strict)]));
  }
  return value;
}

function lookup(expr: string, scope: Scope, strict: boolean): unknown {
  const hit = getPath(scope, expr);
  if (!hit.found || hit.value === undefined) {
    if (strict) throw new Error(`\${${expr}} has no value`);
    return undefined;
  }
  return hit.value;
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function workflowSummaryTokens(result: ToolResult): number {
  return estimateTokens(result.content.map(c => c.text ?? "").join("\n"));
}
