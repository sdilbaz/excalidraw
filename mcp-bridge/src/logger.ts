// Structured JSON-lines logger on stderr. stdout is left untouched so the
// process never interferes with anything reading its output.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

export const parseLogLevel = (value: string | undefined): LogLevel => {
  if (value === undefined || value === "") {
    return "info";
  }
  if (value in LEVEL_RANK) {
    return value as LogLevel;
  }
  throw new Error(
    `Invalid LOG_LEVEL "${value}". Use one of: ${Object.keys(LEVEL_RANK).join(
      ", ",
    )}`,
  );
};

const serializeField = (value: unknown): unknown =>
  value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value;

export const createLogger = (
  minLevel: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger => {
  const log =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
        return;
      }
      const serialized = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          serializeField(value),
        ]),
      );
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          msg,
          ...serialized,
        }),
      );
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
};
