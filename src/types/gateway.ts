/**
 * Gateway configuration and operational types.
 */

export interface DownstreamServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // For remote SSE servers
  pinned?: boolean; // Whether tools should be pinned directly into root prompt
  readOnly?: boolean; // If all tools in this server are idempotent read-only
}

export interface GatewayCacheConfig {
  enabled: boolean;
  exactMatchTtlSeconds: number;
  maxEntries: number;
}

export interface GatewayDiscoveryConfig {
  maxSearchResults: number;
  minScore: number;
}

export interface GatewayConfig {
  gateway: {
    name: string;
    version: string;
    port?: number;
    logLevel?: "debug" | "info" | "warn" | "error";
    cache?: GatewayCacheConfig;
    discovery?: GatewayDiscoveryConfig;
  };
  mcpServers: Record<string, DownstreamServerConfig>;
}
