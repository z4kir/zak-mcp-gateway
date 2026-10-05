import path from "node:path";
import { GoogleGenAI, type Chat, type FunctionCall, type Part } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NextResponse } from "next/server";
import { trimHistory, unverifiedValues } from "./harness";

/**
 * Test harness for the gateway: the same Gemini agent loop runs against
 *   "gateway" -> zak-mcp-gateway (meta-tools, distilled results)
 *   "direct"  -> zak-mcp-gateway --passthrough (every raw tool schema and raw results, i.e. standard MCP)
 * using the same config/servers.json, so token numbers are a fair A/B comparison.
 *
 * Harness options for weaker models (gateway mode):
 *   preload  search the first message up front; put the best signatures (and a matching skill) in the prompt
 *   focused  every question gets its top matching tools as real functions instead of search-then-call
 *   trim     tool results from earlier turns are shortened in the history (every turn re-sends history)
 *   verify   values in the answer (ids, SHAs, numbers) must appear in tool results, else one correction round
 */
type Mode = "gateway" | "direct";

const GATEWAY_ROOT = process.env.GATEWAY_ROOT ?? path.resolve(process.cwd(), "..");
const GATEWAY_CLI = path.join(GATEWAY_ROOT, "dist", "cli.js");
const GATEWAY_CONFIG = process.env.GATEWAY_CONFIG ?? path.join(GATEWAY_ROOT, "config", "servers.json");
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const MAX_MODEL_CALLS = 12;
const FOCUSED_TOOLS = 5;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnection {
  client: Client;
  tools: McpTool[];
  instructions: string;
}

interface ChatState {
  chat: Chat;
  ai: GoogleGenAI;
  model: string;
  systemInstruction: string;
}

// Survive Next.js hot reloads without spawning duplicate gateway processes.
const state = globalThis as unknown as {
  __zakConnections?: Map<Mode, Promise<McpConnection>>;
  __zakChats?: Map<string, ChatState>;
};
const connections = (state.__zakConnections ??= new Map());
const chats = (state.__zakChats ??= new Map());

function getConnection(mode: Mode): Promise<McpConnection> {
  let conn = connections.get(mode);
  if (!conn) {
    conn = (async () => {
      const args = [GATEWAY_CLI, "--config", GATEWAY_CONFIG, ...(mode === "direct" ? ["--passthrough"] : [])];
      const client = new Client({ name: `agent-ui-${mode}`, version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "inherit" }));
      const { tools } = await client.listTools();
      return { client, tools: tools as McpTool[], instructions: client.getInstructions() ?? "" };
    })();
    conn.catch(() => connections.delete(mode)); // allow a retry after a failed start
    connections.set(mode, conn);
  }
  return conn;
}

/** Gemini's parametersJsonSchema takes JSON Schema; only the $schema marker is dropped. */
function toGeminiSchema(schema: Record<string, unknown>): unknown {
  const rest = { ...(schema ?? { type: "object" }) };
  delete rest.$schema;
  return rest;
}

function declarations(tools: McpTool[]) {
  return [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: toGeminiSchema(t.inputSchema) })) }];
}

const textOf = (r: unknown) =>
  (((r as { content?: unknown }).content as { type: string; text?: string }[]) ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");

interface ToolCallLog {
  name: string;
  args: string;
  resultChars: number;
  isError: boolean;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message: string = body.message;
    const mode: Mode = body.mode === "direct" ? "direct" : "gateway";
    const sessionId: string = body.sessionId ?? "default";
    const opts = {
      preload: body.preload !== false,
      focused: body.focused === true,
      trim: body.trim !== false,
      verify: body.verify !== false
    };
    const apiKey: string | undefined = body.apiKey || process.env.GEMINI_API_KEY;
    const model: string = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;

    if (!apiKey) {
      return NextResponse.json({ error: "Missing Gemini API key (enter it in the sidebar or set GEMINI_API_KEY)" }, { status: 400 });
    }
    if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });

    const conn = await getConnection(mode);
    const chatKey = `${sessionId}:${mode}:${model}`;
    let st = chats.get(chatKey);
    let preloaded: string[] = [];
    let skill: string | undefined;
    let trimmedResults = 0;

    const gatewayHelpers = mode === "gateway";
    // Focused tools: this question's best tools as real functions (gateway mode only).
    let focusedTools: McpTool[] = [];
    if (gatewayHelpers && opts.focused) {
      const r = await conn.client.callTool({ name: "mcp_search_tools", arguments: { query: message, limit: FOCUSED_TOOLS, detail: "schema" } });
      try {
        focusedTools = JSON.parse(textOf(r)) as McpTool[];
      } catch {
        focusedTools = [];
      }
    }

    if (!st) {
      let systemInstruction = conn.instructions;
      if (gatewayHelpers && opts.preload) {
        const found = await conn.client.callTool({ name: "mcp_search_tools", arguments: { query: message, limit: 3 } });
        const text = textOf(found);
        const tools = text.replace(/^Relevant skill: .*\n\n/, "");
        if (!opts.focused && !found.isError && !tools.startsWith("No tools matched")) {
          preloaded = tools.split("\n").filter(l => /^\w+__\w+\(/.test(l)).map(l => l.split("(")[0]);
          systemInstruction += `\n\nLikely tools for this request (call them directly with mcp_call_tool):\n${tools}`;
        }
        // A skill matching the first request: load it up front so a weak model doesn't have to decide.
        const name = text.match(/^Relevant skill: (\S+)/)?.[1];
        if (name) {
          const s = await conn.client.callTool({ name: "mcp_get_skill", arguments: { name } });
          if (!s.isError) {
            skill = name;
            systemInstruction += `\n\nFollow this skill for the request:\n${textOf(s)}`;
          }
        }
      }
      const ai = new GoogleGenAI({ apiKey });
      st = { ai, model, systemInstruction, chat: ai.chats.create({ model, config: { systemInstruction: systemInstruction || undefined, tools: declarations([...conn.tools, ...focusedTools]) } }) };
      chats.set(chatKey, st);
    } else if (opts.trim || opts.focused) {
      // Rebuild the chat: shortened old results and/or this question's focused tools.
      let history = st.chat.getHistory();
      if (opts.trim) {
        const t = trimHistory(history);
        history = t.history;
        trimmedResults = t.trimmed;
      }
      st.chat = st.ai.chats.create({
        model,
        history,
        config: { systemInstruction: st.systemInstruction || undefined, tools: declarations([...conn.tools, ...focusedTools]) }
      });
    }
    const chat = st.chat;

    const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, modelCalls: 0 };
    const toolCalls: ToolCallLog[] = [];
    const evidence: string[] = [message];
    const record = (res: Awaited<ReturnType<Chat["sendMessage"]>>) => {
      const u = res.usageMetadata;
      usage.modelCalls++;
      usage.inputTokens += (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0);
      usage.cachedTokens += u?.cachedContentTokenCount ?? 0;
      usage.outputTokens += (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
    };

    const runLoop = async (first: Parameters<Chat["sendMessage"]>[0]) => {
      let response = await sendWithRetry(chat, first);
      record(response);
      let calls: FunctionCall[] = response.functionCalls ?? [];
      while (calls.length > 0 && usage.modelCalls < MAX_MODEL_CALLS) {
        // Answer every function call of this turn (Gemini may ask for several at once).
        const parts: Part[] = await Promise.all(
          calls.map(async call => {
            const name = call.name ?? "";
            const argsText = JSON.stringify(call.args ?? {}).slice(0, 300);
            try {
              const result = await conn.client.callTool({ name, arguments: (call.args ?? {}) as Record<string, unknown> });
              const text = textOf(result);
              evidence.push(text);
              toolCalls.push({ name, args: argsText, resultChars: text.length, isError: !!result.isError });
              return { functionResponse: { id: call.id, name, response: result.isError ? { error: text } : { output: text } } };
            } catch (err) {
              const msg = (err as Error).message;
              toolCalls.push({ name, args: argsText, resultChars: msg.length, isError: true });
              return { functionResponse: { id: call.id, name, response: { error: msg } } };
            }
          })
        );
        response = await sendWithRetry(chat, { message: parts });
        record(response);
        calls = response.functionCalls ?? [];
      }
      return response;
    };

    let response = await runLoop({ message });
    let verifier: { checked: boolean; unverified: string[]; corrected: boolean } = { checked: false, unverified: [], corrected: false };
    if (opts.verify && toolCalls.length > 0 && response.text) {
      const missing = unverifiedValues(response.text, evidence.join("\n"));
      verifier = { checked: true, unverified: missing, corrected: false };
      if (missing.length > 0) {
        response = await runLoop({
          message: `Check your answer: these values do not appear in any tool result: ${missing.join(", ")}. Verify them with a tool or remove them, then give the corrected answer only. If a value was computed by you, say so.`
        });
        verifier.corrected = true;
      }
    }

    return NextResponse.json({
      mode,
      model,
      text: response.text ?? "(no text response)",
      usage,
      toolCalls,
      toolDefinitions: { count: conn.tools.length + focusedTools.length, chars: JSON.stringify([...conn.tools, ...focusedTools]).length + conn.instructions.length },
      preloaded: opts.focused ? focusedTools.map(t => t.name) : preloaded,
      skill,
      trimmedResults,
      verifier
    });
  } catch (error) {
    console.error("Agent API Error:", error);
    return NextResponse.json({ error: friendlyError(error) }, { status: 500 });
  }
}

/**
 * Gemini sometimes answers 503 "high demand" or 500 for a few seconds. Retry those with
 * backoff; never retry 429 quota errors (they last hours).
 */
async function sendWithRetry(chat: Chat, params: Parameters<Chat["sendMessage"]>[0]) {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat.sendMessage(params);
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      const transient = /"code":\s*(500|503)|UNAVAILABLE|INTERNAL|high demand|overloaded/i.test(msg);
      if (!transient || attempt >= delays.length) throw err;
      console.warn(`[agent-ui] Gemini busy (attempt ${attempt + 1}), retrying in ${delays[attempt] / 1000}s`);
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
}

/** Turn Gemini's raw JSON errors (quota, bad model) into one readable line. */
function friendlyError(error: unknown): string {
  const raw = (error as Error)?.message ?? String(error);
  if (/RESOURCE_EXHAUSTED|"code":\s*429|quota/i.test(raw)) {
    const limit = raw.match(/quotaValue"?:\s*"?(\d+)/)?.[1];
    const model = raw.match(/"model":\s*"([^"]+)"/)?.[1];
    const retry = raw.match(/retry in ((?:\d+h)?(?:\d+m)?\d+)(?:\.\d+)?s/i)?.[1];
    return `Gemini free-tier quota used up${model ? ` for ${model}` : ""}${limit ? ` (${limit} requests/day)` : ""}.` +
      `${retry ? ` Resets in ${retry}s.` : ""} Pick another model in the sidebar: each model has its own free quota.`;
  }
  if (/"code":\s*(500|503)|UNAVAILABLE|high demand/i.test(raw)) {
    return "Gemini is overloaded right now (503, retried 3 times). Wait a minute and resend, or pick another model in the sidebar.";
  }
  if (/"code":\s*404|not found/i.test(raw)) return `Model not available for this key: ${raw.slice(0, 200)}`;
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}
