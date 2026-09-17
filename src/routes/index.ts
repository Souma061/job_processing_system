import { Router } from "express";
import jobsRoutes from "./jobs.routes.js";
import systemRoutes from "./system.routes.js";

const router = Router();

// Mount domain routes
router.use("/jobs", jobsRoutes);
router.use("/", systemRoutes); // /health and /logs

export default router;
