import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GatewayConfigSchema, ValidatedGatewayConfig } from "./schema.js";

/**
 * Loads and validates gateway configuration from a JSON file.
 */
export async function loadConfig(configPath?: string): Promise<ValidatedGatewayConfig> {
  const targetPath = configPath 
    ? path.resolve(process.cwd(), configPath)
    : path.resolve(process.cwd(), "config", "servers.json");

  try {
    const rawContent = await fs.readFile(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent);
    return GatewayConfigSchema.parse(parsed);
  } catch (error) {
    if (configPath) {
      throw new Error(`Failed to load config from ${targetPath}: ${(error as Error).message}`);
    }
    // Return default configuration if default path is not found
    return GatewayConfigSchema.parse({
      gateway: {},
      mcpServers: {}
    });
  }
}
