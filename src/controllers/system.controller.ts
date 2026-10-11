import { type Request, type Response } from "express";
import fs from "fs";
import {
  LOG_FILE,
  MAX_QUEUE_CAPACITY,
  MAX_VIP_QUEUE_CAPACITY,
} from "../config/constants.js";
import { getTotalJobsCount } from "../db.js";
import { imageQueue } from "../queue.js";

// GET /health - Server, database, and queue health status
export async function healthCheck(_req: Request, res: Response) {
  try {
    const totalJobs = await getTotalJobsCount();
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
      totalJobs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
}

import { LOG_FILE_PATH, getRecentLogs } from "../logger.js";

// GET /logs - Stream and filter structured logs (supports ?correlationId=... & ?level=...)
export function getLogsStream(req: Request, res: Response) {
  try {
    let entries = getRecentLogs();

    // If in-memory ring buffer is empty, fall back to file if one exists
    if (entries.length === 0) {
      const filePath = fs.existsSync(LOG_FILE_PATH) ? LOG_FILE_PATH : LOG_FILE;
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const rawLines = content.trim().split("\n").filter(Boolean);
        entries = rawLines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    }

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
      const lvl =
        typeof e.level === "string"
          ? e.level
          : e.level === 30
            ? "info"
            : e.level === 40
              ? "warn"
              : e.level === 50
                ? "error"
                : "info";
      const ts = e.timestamp || e.time || "";
      const ctx = e.context || "APP";
      const msg = e.message || e.msg || "";
      return `[${ts}] [${lvl.toUpperCase()}] [${ctx}]${corrTag} ${msg}${dur}${err}`;
    });
    return res.status(200).json(formatted);
  } catch (err) {
    return res.status(500).json({ error: "Failed to read logs" });
  }
}

// GET /metrics - Telemetry, throughput, and latency percentiles (p50, p95, p99)
export async function getMetricsHandler(req: Request, res: Response) {
  try {
    const rawWindow = req.query.windowHours as string | undefined;

    // 1. If caller explicitly requested a non-default window, compute ad-hoc
    if (rawWindow !== undefined && rawWindow !== "24") {
      const { getSystemMetrics } = await import("../metrics.js");
      let windowHours: number | undefined = undefined;
      if (rawWindow.toLowerCase() !== "all" && rawWindow !== "0") {
        const parsed = parseInt(rawWindow, 10);
        if (!isNaN(parsed) && parsed > 0) windowHours = parsed;
      }
      const adHocMetrics = await getSystemMetrics(windowHours);
      return res.status(200).json(adHocMetrics);
    }

    // 2. High-performance cached metrics (Point 1: Anti-stampede guard)
    const { getCachedSystemMetrics } = await import(
      "../services/metrics-refresher.js"
    );
    const cachedMetrics = await getCachedSystemMetrics();

    if (!cachedMetrics) {
      return res.status(503).json({
        error: "METRICS_UNAVAILABLE",
        message:
          "System metrics are initializing or temporarily unavailable. Please retry shortly.",
      });
    }

    return res.status(200).json(cachedMetrics);
  } catch (err: any) {
    return res.status(500).json({
      error: "Failed to retrieve system metrics",
      message: err.message,
    });
  }
}
