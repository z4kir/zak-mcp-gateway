#!/usr/bin/env node
import { loadConfig } from "./config/loader.js";
import { GatewayServer } from "./server/gateway-server.js";

async function main() {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  try {
    const config = await loadConfig(configPath);
    const server = new GatewayServer(config);
    await server.start();
  } catch (err) {
    console.error("[Gateway CLI Fatal Error]", err);
    process.exit(1);
  }
}

main();
