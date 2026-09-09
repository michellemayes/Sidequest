type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.CCSLACK_LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

function emit(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const prefix = `[ccslack] ${level.toUpperCase()}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(`${prefix} ${message}`);
  else stream(`${prefix} ${message}`, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
