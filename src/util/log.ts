/**
 * stderr logger. stdout is reserved for the MCP stdio protocol, so nothing may print there.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  console.error(`[zak-gateway] ${level.toUpperCase()}`, ...args);
}

export const log = {
  setLevel(level: Level): void {
    threshold = LEVELS[level];
  },
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args)
};
