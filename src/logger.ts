import fs from "node:fs";
import path from "node:path";
import pino from "pino";

export interface LogEntry {
  timestamp?: string;
  level: LogLevel;
  context: string;
  message: string;
  correlationId?: string;
  jobId?: string;
  workerId?: string;
  durationMs?: number;
  error?: any;
  metrics?: any;
  [key: string]: any;
}
const LOGS_DIR = path.resolve("logs");
export const LOG_FILE_PATH = path.join(LOGS_DIR, "jobs.jsonl");

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const fileStream = fs.createWriteStream(LOG_FILE_PATH, {
  flags: "a", // Append mode
});

const pinoInstance = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }), // outputs level: "info" instead of numeric 30
    },
    messageKey: "message", // outputs "message" instead of "msg"
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: fileStream },
  ]),
);

export type LogLevel = "info" | "warn" | "error" | "debug";

function formatError(err: any): any {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
}

export function logToFile(entry: LogEntry): void {
  const {
    level = "info",
    context = "APP",
    message = "",
    error,
    ...meta
  } = entry;
  const pinoLevel = (level in pinoInstance ? level : "info") as LogLevel;
  pinoInstance[pinoLevel](
    {
      context,
      error: error ? formatError(error) : undefined,
      ...meta,
    },
    message,
  );
}
export const logger = {
  info: (context: string, message: string, meta: Record<string, any> = {}) =>
    pinoInstance.info({ context, ...meta }, message),
  warn: (context: string, message: string, meta: Record<string, any> = {}) =>
    pinoInstance.warn({ context, ...meta }, message),
  error: (context: string, message: string, meta: Record<string, any> = {}) =>
    pinoInstance.error({ context, ...meta }, message),
  debug: (context: string, message: string, meta: Record<string, any> = {}) =>
    pinoInstance.debug({ context, ...meta }, message),
};
