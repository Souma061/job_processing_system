import { Router } from "express";
import {
  createJob,
  deleteJobsHandler,
  getAllJobsHandler,
  getJobByIdHandler,
} from "../controllers/jobs.controller.js";
import {
  apiKeyAuthMiddleware,
  requireRole,
} from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

const router = Router();

// Protect all /jobs routes with API Key authentication
router.use(apiKeyAuthMiddleware);

// POST /jobs - Enqueue image job
router.post("/", upload.single("imageFile"), createJob);

// GET /jobs - List all jobs with signed URLs
router.get("/", getAllJobsHandler);

// GET /jobs/:id - Get single job details
router.get("/:id", getJobByIdHandler);

// DELETE /jobs - Delete selected or all finished jobs (Admin only)
router.delete("/", requireRole(["admin"]), deleteJobsHandler);

export default router;

