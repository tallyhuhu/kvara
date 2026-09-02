type LogLevel = "info" | "warn" | "error";
type LogContext = Record<string, string | number | boolean | null | undefined>;

export function logInfo(event: string, context: LogContext = {}): void {
  writeLog("info", event, context);
}

export function logWarn(event: string, context: LogContext = {}): void {
  writeLog("warn", event, context);
}

export function logError(event: string, cause: unknown, context: LogContext = {}): void {
  writeLog("error", event, {
    ...context,
    error: cause instanceof Error ? cause.message : "Unknown error"
  });
}

function writeLog(level: LogLevel, event: string, context: LogContext): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...compact(context)
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

function compact(context: LogContext): LogContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}
