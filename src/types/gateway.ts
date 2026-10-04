/**
 * Gateway configuration types (inferred from the zod schema, so they never drift).
 */
export type {
  ValidatedGatewayConfig as GatewayConfig,
  DownstreamServerConfig,
  GatewayResultsConfig,
  GatewaySafetyConfig
} from "../config/schema.js";
