import { type Request, type Response } from "express";
import fs from "fs";
import {
  LOG_FILE,
  MAX_QUEUE_CAPACITY,
  MAX_VIP_QUEUE_CAPACITY,
} from "../config/constants.js";
import { getAllJobs } from "../db.js";
import { imageQueue } from "../queue.js";

// GET /health - Server, database, and queue health status
export async function healthCheck(_req: Request, res: Response) {
  try {
    const jobs = await getAllJobs();
    const waiting = await imageQueue.getWaitingCount();
    const prioritized = await imageQueue.getPrioritizedCount();
    const waitingCount = waiting + prioritized;
    const activeCount = await imageQueue.getActiveCount();

    res.status(200).json({
      status: "ok",
      database: "connected (Neon PostgreSQL)",
      queue: "connected (BullMQ Redis)",
      queueDepth: waitingCount + activeCount,
      waitingCount,
      activeCount,
      maxCapacity: MAX_QUEUE_CAPACITY,
      maxVipCapacity: MAX_VIP_QUEUE_CAPACITY,
      backpressureActive: waitingCount >= MAX_QUEUE_CAPACITY,
      totalJobs: jobs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
}

import { LOG_FILE_PATH } from "../logger.js";

// GET /logs - Stream and filter structured logs (supports ?correlationId=... & ?level=...)
export function getLogsStream(req: Request, res: Response) {
  const filePath = fs.existsSync(LOG_FILE_PATH) ? LOG_FILE_PATH : LOG_FILE;
  if (!fs.existsSync(filePath)) {
    return res.status(200).json([]);
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const rawLines = content.trim().split("\n").filter(Boolean);

    // If it's structured NDJSONL
    if (filePath.endsWith(".jsonl")) {
      let entries = rawLines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const { correlationId, level, limit } = req.query;

      if (correlationId) {
        entries = entries.filter((e) => e.correlationId === correlationId);
      }
      if (level) {
        entries = entries.filter(
          (e) => String(e.level).toLowerCase() === String(level).toLowerCase(),
        );
      }

      const maxLimit = parseInt(String(limit)) || 80;
      entries = entries.slice(-maxLimit);

      // If client requests raw json format
      if (req.query.format === "json") {
        return res.status(200).json(entries);
      }

      // Default formatted strings for web terminal
      const formatted = entries.map((e) => {
        const corrTag = e.correlationId ? ` [${e.correlationId}]` : "";
        const dur = e.durationMs !== undefined ? ` (+${e.durationMs}ms)` : "";
        const err = e.error ? ` [ERROR: ${e.error.message || e.error}]` : "";
        return `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.context}]${corrTag} ${e.message}${dur}${err}`;
      });
      return res.status(200).json(formatted);
    }

    // Fallback for legacy text logs
    const lines = rawLines.slice(-60);
    return res.status(200).json(lines);
  } catch (err) {
    return res.status(500).json({ error: "Failed to read log file" });
  }
}

// GET /metrics - Telemetry, throughput, and latency percentiles (p50, p95, p99)
export async function getMetricsHandler(_req: Request, res: Response) {
  try {
    const { getSystemMetrics } = await import("../metrics.js");
    const metrics = await getSystemMetrics();
    return res.status(200).json(metrics);
  } catch (err: any) {
    return res.status(500).json({
      error: "Failed to compute system metrics",
      message: err.message,
    });
  }
}
