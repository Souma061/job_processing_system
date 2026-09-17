import { type Request, type Response } from "express";
import fs from "fs";
import { LOG_FILE } from "../config/constants.js";
import { getAllJobs } from "../db.js";
import { imageQueue } from "../queue.js";

// GET /health - Server, database, and queue health status
export async function healthCheck(_req: Request, res: Response) {
  try {
    const jobs = await getAllJobs();
    const waitingCount = await imageQueue.getWaitingCount();
    const activeCount = await imageQueue.getActiveCount();

    res.status(200).json({
      status: "ok",
      database: "connected (Neon PostgreSQL)",
      queue: "connected (BullMQ Redis)",
      queueDepth: waitingCount + activeCount,
      totalJobs: jobs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
}

// GET /logs - Stream recent lines from jobs.log
export function getLogsStream(_req: Request, res: Response) {
  if (!fs.existsSync(LOG_FILE)) {
    return res.status(200).json([]);
  }
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-60);
    return res.status(200).json(lines);
  } catch (err) {
    return res.status(500).json({ error: "Failed to read log file" });
  }
}
