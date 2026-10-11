import { Router } from "express";
import {
  getLogsStream,
  getMetricsHandler,
  healthCheck,
} from "../controllers/system.controller.js";
import {
  apiKeyAuthMiddleware,
  requireRole,
} from "../middleware/auth.middleware.js";

const router = Router();

// GET /health - Public endpoint for Docker/K8s liveness & readiness probes
router.get("/health", healthCheck);

// GET /logs - Stream recent jobs.log entries (Admin only)
router.get("/logs", apiKeyAuthMiddleware, requireRole(["admin"]), getLogsStream);

// GET /metrics - Telemetry and latency percentiles (p50, p95, p99)
router.get("/metrics", apiKeyAuthMiddleware, getMetricsHandler);

export default router;

