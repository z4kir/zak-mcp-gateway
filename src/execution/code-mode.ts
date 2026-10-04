import * as vm from "node:vm";
import { ExecutionDispatcher } from "./dispatcher.js";

export interface CodeRunOutcome {
  value: unknown;
  logs: string[];
  toolCalls: number;
  /** Tokens of intermediate tool results that stayed inside the gateway. */
  intermediateTokens: number;
}

/**
 * Code Mode:
 * The model writes a short async JavaScript body that calls several tools with
 * `await call(name, args)` and returns only the final answer. Intermediate results never
 * enter the model's context.
 *
 * SECURITY: node:vm is NOT a security boundary. A determined script can escape to the
 * host process. That is why this mode is off by default, runs read tools only (writes are
 * refused by the policy), and should only be enabled for trusted agents.
 */
export async function runCode(
  code: string,
  dispatcher: ExecutionDispatcher,
  opts: { timeoutMs: number; maxToolCalls: number }
): Promise<CodeRunOutcome> {
  const logs: string[] = [];
  let toolCalls = 0;
  let intermediateTokens = 0;

  // Results cross the boundary as JSON strings, so the script only sees objects created
  // inside its own context.
  const hostCall = async (name: unknown, argsJson: unknown): Promise<string> => {
    if (++toolCalls > opts.maxToolCalls) throw new Error(`tool call limit (${opts.maxToolCalls}) reached`);
    const { value, rawTokens } = await dispatcher.callForCode(String(name), JSON.parse(String(argsJson ?? "{}")));
    intermediateTokens += rawTokens;
    return JSON.stringify(value ?? null);
  };
  const hostLog = (line: unknown) => {
    if (logs.length < 50) logs.push(String(line).slice(0, 500));
  };

  const context = vm.createContext({ __hostCall: hostCall, __hostLog: hostLog }, {
    codeGeneration: { strings: false, wasm: false }
  });
  const wrapped = `
    "use strict";
    const call = async (name, args) => JSON.parse(await __hostCall(name, JSON.stringify(args ?? {})));
    const console = { log: (...a) => __hostLog(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
    (async () => { ${code}\n })().then(v => JSON.stringify(v === undefined ? null : v));
  `;

  const script = new vm.Script(wrapped, { filename: "mcp_run_code.js" });
  const promise = script.runInContext(context, { timeout: opts.timeoutMs }) as Promise<string>;

  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });
  try {
    const json = await Promise.race([promise, timeout]);
    return { value: JSON.parse(json), logs, toolCalls, intermediateTokens };
  } finally {
    clearTimeout(timer!);
  }
}
