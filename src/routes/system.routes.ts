import { Router } from "express";
import { getLogsStream, healthCheck } from "../controllers/system.controller.js";

const router = Router();

// GET /health - System health check
router.get("/health", healthCheck);

// GET /logs - Stream recent jobs.log entries
router.get("/logs", getLogsStream);

export default router;
