/**
 * Child-process runner for mcp_run_code. Started by code-mode.ts with Node's permission
 * model (--permission: no file system, no child processes, no workers, no native addons),
 * a memory cap and a hard timeout. The only way out is the IPC channel: `call(name, args)`
 * asks the parent gateway to run a (read-only) tool through its normal policy.
 */
type FromParent =
  | { type: "run"; code: string }
  | { type: "result"; id: number; ok: boolean; value?: string; error?: string };

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const logs: string[] = [];
let nextId = 0;

const send = (message: unknown) => process.send?.(message);

process.on("message", async (message: FromParent) => {
  if (message.type === "result") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.ok) waiter.resolve(JSON.parse(message.value ?? "null"));
    else waiter.reject(new Error(message.error ?? "tool call failed"));
    return;
  }
  if (message.type !== "run") return;

  // Network APIs are not covered by Node 22's permission model; remove the obvious ones.
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }

  const call = (name: unknown, args: unknown) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ type: "call", id, name: String(name), args: JSON.stringify(args ?? {}) });
    });
  const sandboxConsole = {
    log: (...parts: unknown[]) => {
      if (logs.length < 50) logs.push(parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ").slice(0, 500));
    }
  };

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction("call", "console", `"use strict";\n${message.code}`);
    const value = await fn(call, sandboxConsole);
    send({ type: "done", ok: true, value: JSON.stringify(value === undefined ? null : value), logs });
  } catch (err) {
    send({ type: "done", ok: false, error: (err as Error)?.message ?? String(err), logs });
  }
});

send({ type: "ready" });
