import { Router } from "express";
import {
  getLogsStream,
  getMetricsHandler,
  healthCheck,
} from "../controllers/system.controller.js";

const router = Router();

// GET /health - System health check
router.get("/health", healthCheck);

// GET /logs - Stream recent jobs.log entries
router.get("/logs", getLogsStream);

// GET /metrics - Telemetry and latency percentiles (p50, p95, p99)
router.get("/metrics", getMetricsHandler);

export default router;

