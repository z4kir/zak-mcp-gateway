"use client";

import { useState } from "react";

type Mode = "gateway" | "direct";

interface Usage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  modelCalls: number;
}

interface TurnResult {
  mode: Mode;
  text: string;
  usage: Usage;
  toolCalls: { name: string; args: string; resultChars: number; isError: boolean }[];
  toolDefinitions: { count: number; chars: number };
  preloaded: string[];
  error?: string;
}

interface LogEntry {
  role: "user" | "agent";
  text: string;
  results?: TurnResult[];
}

const emptyUsage = (): Usage => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, modelCalls: 0 });
const newSession = () => Math.random().toString(36).slice(2, 10);

export default function AgentPage() {
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [runMode, setRunMode] = useState<Mode | "compare">("compare");
  const [preload, setPreload] = useState(true);
  const [sessionId, setSessionId] = useState(newSession);
  const [chatLog, setChatLog] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [totals, setTotals] = useState<Record<Mode, Usage>>({ gateway: emptyUsage(), direct: emptyUsage() });

  const runOne = async (mode: Mode, text: string): Promise<TurnResult> => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, apiKey, mode, sessionId, preload })
    });
    const data = await res.json();
    if (data.error) return { mode, text: "", usage: emptyUsage(), toolCalls: [], toolDefinitions: { count: 0, chars: 0 }, preloaded: [], error: data.error };
    return data as TurnResult;
  };

  const sendMessage = async () => {
    if (!message.trim()) return;
    const userMsg = message;
    setMessage("");
    setChatLog(prev => [...prev, { role: "user", text: userMsg }]);
    setIsLoading(true);
    try {
      const modes: Mode[] = runMode === "compare" ? ["direct", "gateway"] : [runMode];
      const results: TurnResult[] = [];
      for (const m of modes) results.push(await runOne(m, userMsg)); // sequential: fair, no shared rate limits
      setChatLog(prev => [...prev, { role: "agent", text: results.find(r => !r.error)?.text ?? results[0].error ?? "", results }]);
      setTotals(prev => {
        const next = { ...prev };
        for (const r of results) {
          if (r.error) continue;
          const t = prev[r.mode];
          next[r.mode] = {
            inputTokens: t.inputTokens + r.usage.inputTokens,
            cachedTokens: t.cachedTokens + r.usage.cachedTokens,
            outputTokens: t.outputTokens + r.usage.outputTokens,
            modelCalls: t.modelCalls + r.usage.modelCalls
          };
        }
        return next;
      });
    } catch (err) {
      setChatLog(prev => [...prev, { role: "agent", text: `Request failed: ${(err as Error).message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const reset = () => {
    setSessionId(newSession());
    setChatLog([]);
    setTotals({ gateway: emptyUsage(), direct: emptyUsage() });
  };

  const saved = totals.direct.inputTokens > 0 && totals.gateway.inputTokens > 0
    ? (1 - totals.gateway.inputTokens / totals.direct.inputTokens) * 100
    : null;

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="w-96 bg-white border-r border-slate-200 p-6 flex flex-col gap-5 overflow-y-auto">
        <div>
          <h1 className="text-xl font-bold text-emerald-700">ZAK Agent UI</h1>
          <p className="text-sm text-slate-500">Gemini agent: direct MCP vs ZAK gateway, measured</p>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Gemini API key</label>
          <input
            type="password"
            className="w-full px-3 py-2 border border-slate-300 rounded text-sm"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="or set GEMINI_API_KEY on the server"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Run against</label>
          <div className="flex gap-1">
            {(["compare", "gateway", "direct"] as const).map(m => (
              <button
                key={m}
                onClick={() => setRunMode(m)}
                className={`flex-1 px-2 py-1.5 rounded text-sm border ${runMode === m ? "bg-emerald-600 text-white border-emerald-600" : "border-slate-300 text-slate-600"}`}
              >
                {m === "compare" ? "Both (A/B)" : m === "gateway" ? "Gateway" : "Direct MCP"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 mt-2 text-sm text-slate-600">
            <input type="checkbox" checked={preload} onChange={e => setPreload(e.target.checked)} />
            Preload likely tools (gateway)
          </label>
        </div>

        <div className="space-y-2">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wide">Session totals (from Gemini usage metadata)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-normal"></th>
                <th className="text-right font-normal">Direct</th>
                <th className="text-right font-normal">Gateway</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {([
                ["Input", "inputTokens"],
                ["  of which cached", "cachedTokens"],
                ["Output", "outputTokens"],
                ["Model calls", "modelCalls"]
              ] as const).map(([label, key]) => (
                <tr key={key}>
                  <td className="font-sans text-slate-600 whitespace-pre">{label}</td>
                  <td className="text-right">{totals.direct[key].toLocaleString()}</td>
                  <td className="text-right">{totals.gateway[key].toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bg-emerald-50 rounded-lg p-4 border border-emerald-200">
            <div className="text-sm text-emerald-700 font-medium">Input tokens saved by gateway</div>
            <div className="text-3xl font-mono font-bold text-emerald-600">{saved === null ? "-" : `${saved.toFixed(1)}%`}</div>
            <div className="text-xs text-emerald-700 mt-1">Only meaningful after running the same prompts in both modes.</div>
          </div>
          <button onClick={reset} className="text-sm text-slate-500 underline">New session</button>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {chatLog.length === 0 && (
            <div className="flex items-center justify-center h-full text-slate-400 text-lg text-center">
              Try: &quot;What are the last 5 commits in modelcontextprotocol/servers?&quot;
            </div>
          )}
          {chatLog.map((log, i) => (
            <div key={i} className={`flex ${log.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-3xl rounded-2xl px-6 py-4 ${log.role === "user" ? "bg-emerald-600 text-white" : "bg-white border border-slate-200 shadow-sm text-slate-800"}`}>
                <pre className="whitespace-pre-wrap font-sans">{log.text}</pre>
                {log.results && (
                  <div className="mt-4 space-y-2">
                    {log.results.map(r => (
                      <div key={r.mode} className="text-xs bg-slate-50 border border-slate-200 rounded p-2">
                        <div className="font-bold text-slate-600">
                          {r.mode === "gateway" ? "Gateway" : "Direct MCP"}: {r.error ? `error: ${r.error}` : `${r.usage.inputTokens.toLocaleString()} in / ${r.usage.outputTokens.toLocaleString()} out, ${r.usage.modelCalls} model calls, ${r.toolDefinitions.count} tool definitions`}
                        </div>
                        {r.preloaded.length > 0 && <div className="text-slate-500">preloaded: {r.preloaded.join(", ")}</div>}
                        {r.toolCalls.map((c, j) => (
                          <div key={j} className={`font-mono ${c.isError ? "text-red-600" : "text-slate-500"}`}>
                            {c.name} {c.args} → {c.resultChars.toLocaleString()} chars
                          </div>
                        ))}
                        {r.mode === "direct" && log.results!.length > 1 && !r.error && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-slate-500">direct answer</summary>
                            <pre className="whitespace-pre-wrap font-sans text-slate-700">{r.text}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white border border-slate-200 shadow-sm rounded-2xl px-6 py-4 text-slate-500 animate-pulse">
                Running agent{runMode === "compare" ? " in both modes" : ""}...
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-white border-t border-slate-200">
          <div className="flex space-x-2 max-w-4xl mx-auto">
            <input
              type="text"
              className="flex-1 px-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
              placeholder="Ask something that needs GitHub..."
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !isLoading && sendMessage()}
              disabled={isLoading}
            />
            <button
              className="px-6 py-3 bg-emerald-600 text-white rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50"
              onClick={sendMessage}
              disabled={isLoading}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
