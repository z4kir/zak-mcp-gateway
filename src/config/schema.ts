import { z } from "zod";

export const DownstreamServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  pinned: z.boolean().default(false),
  readOnly: z.boolean().default(false)
});

export const GatewayCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  exactMatchTtlSeconds: z.number().positive().default(300),
  maxEntries: z.number().positive().default(1000)
});

export const GatewayDiscoveryConfigSchema = z.object({
  maxSearchResults: z.number().positive().default(5),
  minScore: z.number().nonnegative().default(0.2)
});

export const GatewayConfigSchema = z.object({
  gateway: z.object({
    name: z.string().default("zak-mcp-gateway"),
    version: z.string().default("0.1.0"),
    port: z.number().optional(),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    cache: GatewayCacheConfigSchema.default({}),
    discovery: GatewayDiscoveryConfigSchema.default({})
  }).default({}),
  mcpServers: z.record(DownstreamServerConfigSchema).default({})
});

export type ValidatedGatewayConfig = z.infer<typeof GatewayConfigSchema>;
