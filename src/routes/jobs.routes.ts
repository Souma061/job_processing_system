import { Router } from "express";
import {
  createJob,
  deleteJobsHandler,
  getAllJobsHandler,
  getJobByIdHandler,
} from "../controllers/jobs.controller.js";
import { upload } from "../middleware/upload.middleware.js";

const router = Router();

// POST /jobs - Enqueue image job
router.post("/", upload.single("imageFile"), createJob);

// GET /jobs - List all jobs with signed URLs
router.get("/", getAllJobsHandler);

// GET /jobs/:id - Get single job details
router.get("/:id", getJobByIdHandler);

// DELETE /jobs - Delete selected or all finished jobs
router.delete("/", deleteJobsHandler);

export default router;

