import "dotenv/config";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import pino from "pino";
import axiomTransport from "@axiomhq/pino";

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

// Bounded in-memory ring buffer (preserves recent log queries without consuming disk space)
const MAX_RECENT_LOGS = 500;
const recentLogsBuffer: any[] = [];

export function getRecentLogs(): any[] {
  return [...recentLogsBuffer];
}

const memoryStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const parsed = JSON.parse(chunk.toString());
      if (recentLogsBuffer.length >= MAX_RECENT_LOGS) {
        recentLogsBuffer.shift();
      }
      recentLogsBuffer.push(parsed);
    } catch {
      // ignore parse errors
    }
    callback();
  },
});

export const LOG_FILE_PATH = path.resolve("logs", "jobs.jsonl");

const streams: pino.StreamEntry[] = [
  { stream: process.stdout },
  { stream: memoryStream },
];

if (process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET) {
  const axiomPassThrough = new PassThrough();
  streams.push({ stream: axiomPassThrough });

  axiomTransport({
    dataset: process.env.AXIOM_DATASET,
    token: process.env.AXIOM_TOKEN,
  })
    .then((dest) => {
      axiomPassThrough.pipe(dest);
    })
    .catch((err) => {
      console.error("[Logger] Failed to connect Axiom transport:", err);
    });
}

const pinoInstance = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }), // outputs level: "info" instead of numeric 30
    },
    messageKey: "message", // outputs "message" instead of "msg"
  },
  pino.multistream(streams),
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
