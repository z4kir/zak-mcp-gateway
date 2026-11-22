import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CreateMessageRequestSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DownstreamServerConfig } from "../config/schema.js";
import { resolveSecretMap, interpolateEnv } from "../config/loader.js";
import { IdempotencyGuard } from "../gate/idempotency.js";
import { DownstreamTool, ToolAnnotations, ToolInputSchema, ToolResult } from "../types/tool.js";
import { log } from "../util/log.js";
import { singular } from "../discovery/catalog.js";

/** Separator between server id and tool name. "__" is valid in every LLM provider's tool-name rules. */
export const NAMESPACE_SEP = "__";

/** Forwards server-to-client requests (elicitation, sampling) to the agent's own client. */
export interface ClientFeatureForwarder {
  elicit(params: unknown, serverId: string): Promise<unknown>;
  sample(params: unknown, serverId: string): Promise<unknown>;
}

/** starting: connecting now · ok: connected · failed: could not connect · disconnected: was connected, connection closed. */
export type ServerState = "starting" | "ok" | "failed" | "disconnected";

export interface ServerStatus {
  serverId: string;
  state: ServerState;
  /** Tool count from the last successful connection. */
  tools?: number;
  /** Why the server is failed or disconnected (secrets removed). */
  error?: string;
  /** When the server entered its current state (ISO time). */
  since: string;
  /** Connection attempts so far. */
  attempts: number;
}

type ReadyHandler = (serverId: string, tools: DownstreamTool[]) => void;

/**
 * Downstream Client Pool:
 * Connects to every configured MCP server in parallel (stdio or remote HTTP), catalogs
 * their tools under namespaced names, routes calls, and tracks each server's state so a
 * failed or dropped server can be reported and reconnected without restarting the gateway.
 */
export class DownstreamClientPool {
  private forwarder?: ClientFeatureForwarder;

  constructor(private features: { elicitation?: boolean; sampling?: boolean } = {}) {}

  public setForwarder(forwarder: ClientFeatureForwarder): void {
    this.forwarder = forwarder;
  }

  private clients = new Map<string, Client>();
  private tools = new Map<string, DownstreamTool>();
  private configs: Record<string, DownstreamServerConfig> = {};
  private serverInstructions = new Map<string, string>();

  /** Servers still connecting, each with a promise that settles when it is up or has failed. */
  private pending = new Map<string, Promise<void>>();
  /** Clients whose transport is being connected (their child process may already run). */
  private connecting = new Map<string, Client>();
  private closed = false;
  private states = new Map<string, ServerStatus>();
  private lastAttempt = new Map<string, number>();
  private listeners: Array<(status: ServerStatus) => void> = [];

  /** Called on every state change of any server (for status files, notifications). */
  public onStatusChange(listener: (status: ServerStatus) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Connects every server in parallel. `onReady` runs as soon as each server is up, so its
   * tools can be used before slower servers finish. Resolves with all tools once every
   * server has connected or failed.
   */
  public async initializeServers(
    servers: Record<string, Partial<DownstreamServerConfig>>,
    onReady?: ReadyHandler
  ): Promise<DownstreamTool[]> {
    const entries = Object.entries(servers);
    for (const [serverId, cfg] of entries) this.configs[serverId] = cfg as DownstreamServerConfig;
    this.readyHandler = onReady;
    const results = await Promise.all(entries.map(([serverId]) => this.startServer(serverId, onReady)));
    return results.flatMap(tools => tools ?? []);
  }

  /** The handler from initializeServers, reused when a server reconnects. */
  private readyHandler?: ReadyHandler;

  /**
   * Connects a server that is failed or disconnected again (waits if it is starting). A server
   * that is up is left alone unless `force` is set (e.g. after a deploy of a remote server).
   * Its tools replace the old ones and are passed to `onReady`.
   */
  public async reconnect(serverId: string, onReady: ReadyHandler | undefined = this.readyHandler, force = false): Promise<ServerStatus> {
    if (!(serverId in this.configs)) throw new Error(`Unknown server "${serverId}".`);
    if (this.closed) throw new Error("The gateway is closing.");
    const pending = this.pending.get(serverId);
    if (pending) await pending;
    else if (force || this.states.get(serverId)?.state !== "ok") await this.startServer(serverId, onReady);
    return this.statusOf(serverId)!;
  }

  /** A failed or disconnected server whose last attempt is at least `retryAfterMs` old. */
  public canRetry(serverId: string, retryAfterMs: number): boolean {
    const state = this.states.get(serverId)?.state;
    if (state !== "failed" && state !== "disconnected") return false;
    return Date.now() - (this.lastAttempt.get(serverId) ?? 0) >= retryAfterMs;
  }

  /** Ids of servers that are still connecting. */
  public pendingServers(): string[] {
    return [...this.pending.keys()];
  }

  /** Waits until this server has connected or failed (no-op if it is not starting). */
  public async whenSettled(serverId: string): Promise<void> {
    await this.pending.get(serverId);
  }

  public statusOf(serverId: string): ServerStatus | undefined {
    const s = this.states.get(serverId);
    return s ? { ...s } : undefined;
  }

  /** State of every configured server, in config order. */
  public serverStatus(): ServerStatus[] {
    return Object.keys(this.configs).map(
      id => this.statusOf(id) ?? { serverId: id, state: "starting", since: new Date().toISOString(), attempts: 0 }
    );
  }

  public serverIds(): string[] {
    return Object.keys(this.configs);
  }

  private setState(serverId: string, patch: Omit<Partial<ServerStatus>, "serverId" | "since"> & { state: ServerState }): void {
    const prev = this.states.get(serverId);
    const next: ServerStatus = {
      serverId,
      attempts: prev?.attempts ?? 0,
      tools: prev?.tools,
      since: prev && prev.state === patch.state ? prev.since : new Date().toISOString(),
      ...patch
    };
    if (patch.state === "ok" || patch.state === "starting") delete next.error;
    this.states.set(serverId, next);
    for (const listener of this.listeners) {
      try {
        listener({ ...next });
      } catch (err) {
        log.error(`[pool] status listener failed: ${(err as Error).message}`);
      }
    }
  }

  private startServer(serverId: string, onReady?: ReadyHandler): Promise<DownstreamTool[] | undefined> {
    this.lastAttempt.set(serverId, Date.now());
    this.setState(serverId, { state: "starting", attempts: (this.states.get(serverId)?.attempts ?? 0) + 1 });
    const done = this.connectServer(serverId)
      .then(
        tools => {
          this.setState(serverId, { state: "ok", tools: tools.length });
          log.info(`[pool] ${serverId}: ${tools.length} tools`);
          try {
            onReady?.(serverId, tools);
          } catch (err) {
            log.error(`[pool] ${serverId}: registering tools failed: ${(err as Error).message}`);
          }
          return tools;
        },
        err => {
          const message = this.redact(serverId, (err as Error)?.message ?? String(err));
          this.setState(serverId, { state: "failed", error: message });
          if (!this.closed) log.error(`[pool] ${serverId}: failed to connect: ${message}`);
          return undefined;
        }
      )
      .finally(() => this.pending.delete(serverId));
    this.pending.set(serverId, done.then(() => undefined));
    return done;
  }

  private async connectServer(serverId: string): Promise<DownstreamTool[]> {
    const config = this.configs[serverId];
    const capabilities = {
      ...(this.features.elicitation ? { elicitation: {} } : {}),
      ...(this.features.sampling ? { sampling: {} } : {})
    };
    const client = new Client({ name: `zak-gateway-${serverId}`, version: "0.5.0" }, { capabilities });
    if (this.features.elicitation) {
      client.setRequestHandler(ElicitRequestSchema, async request => {
        if (!this.forwarder) return { action: "decline" };
        return (await this.forwarder.elicit(request.params, serverId)) as never;
      });
    }
    if (this.features.sampling) {
      client.setRequestHandler(CreateMessageRequestSchema, async request => {
        if (!this.forwarder) throw new Error("The gateway has no agent client connected for sampling.");
        return (await this.forwarder.sample(request.params, serverId)) as never;
      });
    }
    // A connection that closes later (server crash, HTTP endpoint gone) marks the server
    // disconnected; the next call to it reconnects.
    client.onclose = () => this.handleClose(serverId, client);
    const timeoutMs = config.connectTimeoutMs ?? 60_000;

    this.connecting.set(serverId, client);
    try {
      await withTimeout(this.connectTransport(serverId, config, client), timeoutMs, `connect timed out after ${timeoutMs}ms`);
    } catch (err) {
      await client.close().catch(() => undefined); // don't leave a half-started child process behind
      throw err;
    } finally {
      this.connecting.delete(serverId);
    }
    if (this.closed) {
      // The gateway was closed while this server was still starting: stop it again.
      await client.close().catch(() => undefined);
      throw new Error("the gateway closed while this server was starting");
    }
    const old = this.clients.get(serverId);
    this.clients.set(serverId, client);
    if (old && old !== client) await old.close().catch(() => undefined);
    const instructions = client.getInstructions();
    if (instructions?.trim()) this.serverInstructions.set(serverId, instructions.trim());

    const tools: DownstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        const annotations = tool.annotations as ToolAnnotations | undefined;
        tools.push({
          serverId,
          name: tool.name,
          namespacedName: `${serverId}${NAMESPACE_SEP}${tool.name}`,
          description: tool.description || "",
          inputSchema: tool.inputSchema as ToolInputSchema,
          outputSchema: tool.outputSchema as ToolInputSchema | undefined,
          annotations,
          access: config.access?.[tool.name] ?? IdempotencyGuard.classify(tool.name, annotations),
          isPinned: config.pinned || false,
          ...(config.label ? { serverLabel: config.label } : {})
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    // A reconnect replaces the server's old tool list (tools may have changed in a deploy).
    for (const [name, t] of this.tools) if (t.serverId === serverId) this.tools.delete(name);
    for (const t of tools) this.tools.set(t.namespacedName, t);
    return tools;
  }

  private handleClose(serverId: string, client: Client): void {
    if (this.closed || this.clients.get(serverId) !== client) return;
    this.clients.delete(serverId);
    this.setState(serverId, { state: "disconnected", error: "the connection closed" });
    log.warn(`[pool] ${serverId}: connection closed; the next call to it reconnects.`);
  }

  private async connectTransport(serverId: string, config: DownstreamServerConfig, client: Client): Promise<void> {
    if (config.command) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
      Object.assign(env, resolveSecretMap(serverId, config.env, "env"));
      const args = (config.args ?? []).map(a => interpolateEnv(a) ?? a);
      await client.connect(new StdioClientTransport({ command: config.command, args, env, stderr: "inherit" }));
      return;
    }
    if (config.url) {
      const url = new URL(interpolateEnv(config.url) ?? config.url);
      const headers = resolveSecretMap(serverId, config.headers, "headers");
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      } catch (err) {
        // A rejected login will not work over SSE either; keep the server's own explanation.
        const status = httpStatusOf(err);
        if (status === 401 || status === 403) throw new Error(authErrorMessage(status, err));
        log.warn(`[pool] ${serverId}: Streamable HTTP failed (${this.redact(serverId, errorText(err))}); trying SSE.`);
        try {
          await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
        } catch (sseErr) {
          const sseStatus = httpStatusOf(sseErr);
          if (sseStatus === 401 || sseStatus === 403) throw new Error(authErrorMessage(sseStatus, sseErr));
          throw new Error(`Streamable HTTP: ${errorText(err)} | SSE fallback: ${errorText(sseErr)}`);
        }
      }
      return;
    }
    throw new Error(`server "${serverId}" needs "command" or "url"`);
  }

  /** Removes this server's secret values (resolved env and header values) and token-like strings. */
  public redact(serverId: string, text: string): string {
    const config = this.configs[serverId];
    const values: string[] = [];
    for (const map of [config?.env, config?.headers]) {
      for (const raw of Object.values(map ?? {})) {
        const value = interpolateEnv(raw);
        if (!value) continue;
        values.push(value, ...value.split(/\s+/));
      }
    }
    let out = text;
    for (const v of values.filter(v => v.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
    return out.replace(/\b(gh[pousr]_|github_pat_|xox[abposr]-|sk-|AKIA|AIza)[A-Za-z0-9_-]{10,}/g, "***");
  }

  /**
   * Calls a tool. A connection failure (refused, reset, closed socket, unknown session after
   * a server restart) marks the server disconnected, so the next call reconnects it. A read is
   * then retried once on a fresh connection, since running a read twice changes nothing;
   * writes are never retried, so they cannot run twice.
   */
  public async callTool(tool: DownstreamTool, args: Record<string, unknown>, retried = false): Promise<ToolResult> {
    const client = this.clients.get(tool.serverId);
    if (!client) {
      const s = this.states.get(tool.serverId);
      const why = s ? `${s.state}${s.error ? `: ${s.error}` : ""}` : "not started";
      throw new Error(`Downstream server "${tool.serverId}" is not connected (${why}). mcp_status shows details and can reconnect it.`);
    }
    try {
      return (await client.callTool({ name: tool.name, arguments: args })) as ToolResult;
    } catch (err) {
      const kind = connectionFailure(err);
      if (!kind) throw err;
      this.dropClient(tool.serverId, client, this.redact(tool.serverId, errorText(err)));
      if (tool.access === "read" && !retried && !this.closed) {
        log.info(`[pool] ${tool.serverId}: reconnecting and retrying the read ${tool.name}`);
        const st = await this.reconnect(tool.serverId);
        if (st.state === "ok") {
          const fresh = this.tools.get(tool.namespacedName) ?? tool;
          return this.callTool(fresh, args, true);
        }
      }
      if (tool.access === "write") {
        // Tell the agent whether the change happened, so it does not repeat it blindly.
        const outcome = kind === "not-sent"
          ? "before the request arrived, so this change did not run"
          : "during the call, so this change may or may not have run: check before repeating it";
        throw new Error(`${errorText(err)}. The connection to "${tool.serverId}" was lost ${outcome}. The next call reconnects.`);
      }
      throw err;
    }
  }

  /** Forget a client whose connection failed: the server becomes disconnected and is reconnected later. */
  private dropClient(serverId: string, client: Client, reason: string): void {
    if (this.clients.get(serverId) !== client) return;
    this.clients.delete(serverId);
    this.setState(serverId, { state: "disconnected", error: reason });
    log.warn(`[pool] ${serverId}: connection lost (${reason}); the next call reconnects.`);
    void client.close().catch(() => undefined);
  }

  /** The downstream server's own MCP instructions, if it sent any. */
  public getServerInstructions(serverId: string): string | undefined {
    return this.serverInstructions.get(serverId);
  }

  public getClient(serverId: string): Client | undefined {
    return this.clients.get(serverId);
  }

  public getServerConfig(serverId: string): DownstreamServerConfig | undefined {
    return this.configs[serverId];
  }

  public getTool(namespacedName: string): DownstreamTool | undefined {
    return this.tools.get(namespacedName);
  }

  /**
   * A protected server (its own `confirmWrites: true`) is reached only by naming it: a bare or
   * fuzzy tool name never resolves to it. Otherwise a bare name that two servers share (a
   * local and a live copy) would silently go to the live one whenever the local one is down.
   */
  public isProtected(serverId: string): boolean {
    return this.configs[serverId]?.confirmWrites === true;
  }

  /**
   * Tolerant lookup: accepts "github__list_commits", "github::list_commits",
   * "github.list_commits", "github/list_commits", or a bare "list_commits" when unique.
   * Saves a failed round trip when the model writes the name slightly differently.
   */
  public resolveTool(name: string): DownstreamTool | undefined {
    const exact = this.tools.get(name);
    if (exact) return exact;
    const normalized = name.trim().replace(/::|\.|\/|:/, NAMESPACE_SEP);
    const viaSep = this.tools.get(normalized);
    if (viaSep) return viaSep;
    const unnamed = [...this.tools.values()].filter(t => !this.isProtected(t.serverId));
    const bare = unnamed.filter(t => t.name === name.trim());
    if (bare.length === 1) return bare[0];

    // Singular/plural and case tolerant: "github__list_issue" -> github__list_issues.
    const loose = looseName(normalized);
    const hits = normalized.includes(NAMESPACE_SEP)
      ? [...this.tools.values()].filter(t => looseName(t.namespacedName) === loose)
      : unnamed.filter(t => looseName(t.name) === loose);
    return hits.length === 1 ? hits[0] : undefined;
  }

  public getAllTools(): DownstreamTool[] {
    return [...this.tools.values()];
  }

  /** Closes every connected server and stops the ones still starting (no child process is left behind). */
  public async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.clients.entries(), ...this.connecting.entries()].map(async ([id, client]) => {
        try {
          await client.close();
        } catch (err) {
          log.error(`[pool] error closing ${id}:`, err);
        }
      })
    );
    this.clients.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function looseName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join("_");
}

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/**
 * Classifies a thrown call error. "not-sent": the request never reached a live session
 * (refused connection, unknown host, unknown session after a server restart), so a retry is
 * safe. "maybe-sent": the connection broke during the call. undefined: not a connection
 * problem (the server answered with an error).
 */
function connectionFailure(err: unknown): "not-sent" | "maybe-sent" | undefined {
  const text = `${errorText(err)} ${(err as { cause?: unknown })?.cause ? errorText((err as { cause?: unknown }).cause) : ""}`;
  const code = (err as { code?: unknown })?.code;
  // A break during the exchange first: "fetch failed" can also wrap "other side closed".
  if (/Connection closed|ECONNRESET|socket hang up|other side closed|terminated|EPIPE/i.test(text)) return "maybe-sent";
  if (code === 404 || /session not found|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|Not connected/i.test(text)) return "not-sent";
  return undefined;
}

/** HTTP status from an MCP transport error (Streamable HTTP sets `code`; SSE puts it in the message). */
function httpStatusOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "number" && code >= 400 && code < 600) return code;
  const m = /\b(?:HTTP |status code \(|Non-200 status code \()(\d{3})/i.exec(errorText(err));
  return m ? Number(m[1]) : undefined;
}

/** "HTTP 401 Unauthorized: <the server's own text>. Check this server's headers ..." */
function authErrorMessage(status: number, err: unknown): string {
  const serverText = errorText(err)
    .replace(/^Streamable HTTP error:\s*/i, "")
    .replace(/^Error POSTing to endpoint:?\s*/i, "")
    .replace(/^SSE error:\s*/i, "")
    .trim()
    .slice(0, 240);
  return (
    `HTTP ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}${serverText ? `: ${serverText}` : ""}. ` +
    `Check this server's "headers" in servers.json (many servers expect "Authorization": "Bearer <token>").`
  );
}
