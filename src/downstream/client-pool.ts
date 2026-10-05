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

/**
 * Downstream Client Pool:
 * Connects to every configured MCP server in parallel (stdio or remote HTTP), catalogs
 * their tools under namespaced names, and routes calls.
 */
/** Forwards server-to-client requests (elicitation, sampling) to the agent's own client. */
export interface ClientFeatureForwarder {
  elicit(params: unknown, serverId: string): Promise<unknown>;
  sample(params: unknown, serverId: string): Promise<unknown>;
}

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

  public async initializeServers(servers: Record<string, Partial<DownstreamServerConfig>>): Promise<DownstreamTool[]> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(entries.map(([id, cfg]) => this.connectServer(id, cfg)));

    const discovered: DownstreamTool[] = [];
    results.forEach((res, i) => {
      const [serverId] = entries[i];
      if (res.status === "fulfilled") {
        discovered.push(...res.value);
        log.info(`[pool] ${serverId}: ${res.value.length} tools`);
      } else {
        log.error(`[pool] ${serverId}: failed to connect: ${(res.reason as Error)?.message ?? res.reason}`);
      }
    });
    return discovered;
  }

  private async connectServer(serverId: string, partial: Partial<DownstreamServerConfig>): Promise<DownstreamTool[]> {
    const config = partial as DownstreamServerConfig;
    this.configs[serverId] = config;
    const capabilities = {
      ...(this.features.elicitation ? { elicitation: {} } : {}),
      ...(this.features.sampling ? { sampling: {} } : {})
    };
    const client = new Client({ name: `zak-gateway-${serverId}`, version: "0.3.0" }, { capabilities });
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
    const timeoutMs = config.connectTimeoutMs ?? 60_000;

    try {
      await withTimeout(this.connectTransport(serverId, config, client), timeoutMs, `connect timed out after ${timeoutMs}ms`);
    } catch (err) {
      await client.close().catch(() => undefined); // don't leave a half-started child process behind
      throw err;
    }
    this.clients.set(serverId, client);
    const instructions = client.getInstructions();
    if (instructions?.trim()) this.serverInstructions.set(serverId, instructions.trim());

    const tools: DownstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        const annotations = tool.annotations as ToolAnnotations | undefined;
        const downstreamTool: DownstreamTool = {
          serverId,
          name: tool.name,
          namespacedName: `${serverId}${NAMESPACE_SEP}${tool.name}`,
          description: tool.description || "",
          inputSchema: tool.inputSchema as ToolInputSchema,
          outputSchema: tool.outputSchema as ToolInputSchema | undefined,
          annotations,
          access: config.access?.[tool.name] ?? IdempotencyGuard.classify(tool.name, annotations),
          isPinned: config.pinned || false
        };
        this.tools.set(downstreamTool.namespacedName, downstreamTool);
        tools.push(downstreamTool);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
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
        log.warn(`[pool] ${serverId}: Streamable HTTP failed (${(err as Error).message}); trying SSE.`);
        await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
      }
      return;
    }
    throw new Error(`server "${serverId}" needs "command" or "url"`);
  }

  public async callTool(tool: DownstreamTool, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.clients.get(tool.serverId);
    if (!client) throw new Error(`Downstream server "${tool.serverId}" is not connected.`);
    return (await client.callTool({ name: tool.name, arguments: args })) as ToolResult;
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
    const bare = [...this.tools.values()].filter(t => t.name === name.trim());
    if (bare.length === 1) return bare[0];

    // Singular/plural and case tolerant: "github__list_issue" -> github__list_issues.
    const loose = looseName(normalized);
    const hits = [...this.tools.values()].filter(t =>
      normalized.includes(NAMESPACE_SEP) ? looseName(t.namespacedName) === loose : looseName(t.name) === loose
    );
    return hits.length === 1 ? hits[0] : undefined;
  }

  public getAllTools(): DownstreamTool[] {
    return [...this.tools.values()];
  }

  public async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.entries()].map(async ([id, client]) => {
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
