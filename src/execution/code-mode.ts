import * as vm from "node:vm";
import * as path from "node:path";
import { fork } from "node:child_process";
import { ExecutionDispatcher } from "./dispatcher.js";

export interface CodeRunOutcome {
  value: unknown;
  logs: string[];
  toolCalls: number;
  /** Tokens of intermediate tool results that stayed inside the gateway. */
  intermediateTokens: number;
}

export interface CodeRunOptions {
  timeoutMs: number;
  maxToolCalls: number;
  isolation?: "process" | "vm";
  memoryMb?: number;
}

/**
 * Code Mode:
 * The model writes a short async JavaScript body that calls several tools with
 * `await call(name, args)` and returns only the final answer. Intermediate results never
 * enter the model's context. Tool calls go through the normal dispatcher: read tools only.
 *
 * isolation "process" (default): a separate Node process with the permission model
 * (no file system, child processes, workers or addons), a memory cap and a hard kill on
 * timeout. Network APIs are removed but not fully blockable on Node 22.
 * isolation "vm": in-process node:vm. NOT a security boundary; trusted agents only.
 */
export async function runCode(code: string, dispatcher: ExecutionDispatcher, opts: CodeRunOptions): Promise<CodeRunOutcome> {
  return opts.isolation === "vm" ? runInVm(code, dispatcher, opts) : runInProcess(code, dispatcher, opts);
}

function makeToolBridge(dispatcher: ExecutionDispatcher, maxToolCalls: number) {
  const state = { toolCalls: 0, intermediateTokens: 0 };
  const callTool = async (name: string, argsJson: string): Promise<string> => {
    if (++state.toolCalls > maxToolCalls) throw new Error(`tool call limit (${maxToolCalls}) reached`);
    const { value, rawTokens } = await dispatcher.callForCode(name, JSON.parse(argsJson || "{}"));
    state.intermediateTokens += rawTokens;
    return JSON.stringify(value ?? null);
  };
  return { state, callTool };
}

async function runInProcess(code: string, dispatcher: ExecutionDispatcher, opts: CodeRunOptions): Promise<CodeRunOutcome> {
  const runner = path.join(__dirname, "code-runner.js");
  const child = fork(runner, [], {
    execArgv: ["--permission", `--allow-fs-read=${runner}`, `--max-old-space-size=${opts.memoryMb ?? 64}`],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json"
  });
  let stderr = "";
  child.stderr?.on("data", d => {
    if (stderr.length < 2000) stderr += String(d);
  });
  const { state, callTool } = makeToolBridge(dispatcher, opts.maxToolCalls);

  try {
    return await new Promise<CodeRunOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`code timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      child.on("error", err => done(() => reject(err)));
      child.on("exit", codeNum =>
        done(() => reject(new Error(`code process exited (${codeNum})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)))
      );
      child.on("message", async (m: Record<string, unknown>) => {
        if (m.type === "ready") {
          child.send({ type: "run", code });
        } else if (m.type === "call") {
          try {
            const value = await callTool(String(m.name), String(m.args));
            child.send({ type: "result", id: m.id, ok: true, value });
          } catch (err) {
            child.send({ type: "result", id: m.id, ok: false, error: (err as Error).message });
          }
        } else if (m.type === "done") {
          const logs = Array.isArray(m.logs) ? (m.logs as string[]) : [];
          if (m.ok) done(() => resolve({ value: JSON.parse(String(m.value)), logs, ...state }));
          else done(() => reject(new Error(String(m.error))));
        }
      });
    });
  } finally {
    child.removeAllListeners();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function runInVm(code: string, dispatcher: ExecutionDispatcher, opts: CodeRunOptions): Promise<CodeRunOutcome> {
  const logs: string[] = [];
  const { state, callTool } = makeToolBridge(dispatcher, opts.maxToolCalls);
  const hostLog = (line: unknown) => {
    if (logs.length < 50) logs.push(String(line).slice(0, 500));
  };
  // Results cross the boundary as JSON strings, so the script only sees objects created
  // inside its own context.
  const context = vm.createContext({ __hostCall: callTool, __hostLog: hostLog }, { codeGeneration: { strings: false, wasm: false } });
  const wrapped = `
    "use strict";
    const call = async (name, args) => JSON.parse(await __hostCall(String(name), JSON.stringify(args ?? {})));
    const console = { log: (...a) => __hostLog(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
    (async () => { ${code}\n })().then(v => JSON.stringify(v === undefined ? null : v));
  `;
  const promise = new vm.Script(wrapped, { filename: "mcp_run_code.js" }).runInContext(context, { timeout: opts.timeoutMs }) as Promise<string>;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });
  try {
    const json = await Promise.race([promise, timeout]);
    return { value: JSON.parse(json), logs, ...state };
  } finally {
    clearTimeout(timer!);
  }
}
