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
  const record: LogEntry = {
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
    error: entry.error ? formatError(entry.error) : undefined,
  };
  //write NDJSONL (Newline Delimited JSON) to disk
  try {
    fs.appendFileSync(LOG_FILE_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write log entry to file:", err);
  }
  //pretty print to console
  const colorMap: Record<LogLevel, string> = {
    debug: "\x1b[90m", // Gray
    info: "\x1b[36m", // Cyan
    warn: "\x1b[33m", // Yellow
    error: "\x1b[31m", // Red
  };
  const reset = "\x1b[0m";
  const color = colorMap[record.level] || reset;
  const corrTag = record.correlationId
    ? ` [\x1b[35m${record.correlationId}\x1b[0m]`
    : "";
  const jobTag = record.jobId ? ` (\x1b[34m${record.jobId}\x1b[0m)` : "";
  const durTag =
    record.durationMs !== undefined
      ? ` \x1b[32m+${record.durationMs}ms\x1b[0m`
      : "";
  console.log(
    `${color}[${record.level.toUpperCase()}]${reset} [${record.context}]${corrTag}${jobTag} ${record.message}${durTag}`,
  );
  if (record.error) {
    console.error(
      `${color}[${record.level.toUpperCase()}]${reset} [${record.context}]${corrTag}${jobTag} Error:`,
      record.error,
    );
  }
}
export const logger = {
  info: (
    context: string,
    message: string,
    meta: Omit<LogEntry, "level" | "context" | "message"> = {},
  ) => logToFile({ level: "info", context, message, ...meta }),
  warn: (
    context: string,
    message: string,
    meta: Omit<LogEntry, "level" | "context" | "message"> = {},
  ) => logToFile({ level: "warn", context, message, ...meta }),
  error: (
    context: string,
    message: string,
    meta: Omit<LogEntry, "level" | "context" | "message"> = {},
  ) => logToFile({ level: "error", context, message, ...meta }),
  debug: (
    context: string,
    message: string,
    meta: Omit<LogEntry, "level" | "context" | "message"> = {},
  ) => logToFile({ level: "debug", context, message, ...meta }),
};
