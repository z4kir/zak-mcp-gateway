import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GatewayConfigSchema, ValidatedGatewayConfig } from "./schema.js";
import { log } from "../util/log.js";

export type LoadedGatewayConfig = ValidatedGatewayConfig & {
  /** Directory relative paths in the config (e.g. stats.logFile) resolve against. */
  configDir: string;
};

/** Values like "<YOUR_GITHUB_TOKEN>" or "your-token-here" are placeholders, not secrets. */
const PLACEHOLDER = /^<[^>]*>$|^your[-_ ].*here$|^changeme$/i;

/** Literal credentials that should live in the environment, not in a config file. */
const LITERAL_SECRET = /^(gh[pousr]_|github_pat_|xox[abposr]-|sk-|AKIA|AIza)[A-Za-z0-9_\-]{10,}/;

/**
 * Replace ${VAR} and ${VAR:-default} with values from `env`.
 * Returns undefined when a referenced variable is missing and has no default.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let missing = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    missing = true;
    return "";
  });
  return missing ? undefined : out;
}

/**
 * Resolve a server's env/header map: interpolate ${VAR}, drop placeholders and unresolved
 * values (so an already-exported variable of the same name is inherited instead of being
 * overwritten with junk), and warn about literal secrets.
 */
export function resolveSecretMap(
  serverId: string,
  map: Record<string, string> | undefined,
  kind: "env" | "headers"
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(map ?? {})) {
    if (PLACEHOLDER.test(raw.trim())) {
      log.warn(`[config] ${serverId}.${kind}.${key} is a placeholder; using the environment value if set.`);
      continue;
    }
    if (LITERAL_SECRET.test(raw.trim())) {
      log.warn(`[config] ${serverId}.${kind}.${key} looks like a hard-coded secret. Prefer "\${${key}}" and export it in the environment.`);
    }
    const value = interpolateEnv(raw);
    if (value === undefined) {
      log.warn(`[config] ${serverId}.${kind}.${key} references an unset environment variable; skipped.`);
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Loads and validates gateway configuration from a JSON file.
 */
export async function loadConfig(configPath?: string): Promise<LoadedGatewayConfig> {
  const targetPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.resolve(process.cwd(), "config", "servers.json");

  let rawContent: string;
  try {
    rawContent = await fs.readFile(targetPath, "utf-8");
  } catch (error) {
    if (configPath) {
      throw new Error(`Failed to read config ${targetPath}: ${(error as Error).message}`);
    }
    log.warn(`[config] ${targetPath} not found; starting with no downstream servers.`);
    return { ...GatewayConfigSchema.parse({}), configDir: process.cwd() };
  }

  const parsed = GatewayConfigSchema.safeParse(JSON.parse(rawContent));
  if (!parsed.success) {
    throw new Error(`Invalid config ${targetPath}: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { ...parsed.data, configDir: path.dirname(targetPath) };
}
