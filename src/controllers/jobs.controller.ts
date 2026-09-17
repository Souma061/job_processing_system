import crypto from "crypto";
import { type Request, type Response } from "express";
import { appendToLogFile } from "../config/constants.js";
import {
  deleteAllFinishedJobs,
  deleteJobsByIds,
  getAllJobs,
  getJobById,
} from "../db.js";
import { imageQueue } from "../queue.js";
import { deleteFileFromS3, getPresignedDownloadUrl } from "../s3.js";

// POST /jobs - Enqueue a new job to BullMQ
export async function createJob(req: Request, res: Response) {
  const image = req.file ? req.file.filename : req.body.image;
  const type = req.body.type || "thumbnail";
  const originalName = req.file ? req.file.originalname : image;

  if (!image) {
    return res.status(400).json({
      error: "No image provided. Please select an image file or provide an image name.",
    });
  }

  try {
    const jobId = `job-${crypto.randomUUID()}`;

    // 🚀 Push immediately to Redis (BullMQ handles 100,000+ ops/sec in RAM!)
    await imageQueue.add(
      "process-image",
      {
        id: jobId,
        type,
        originalName,
        image,
        createdAt: new Date().toISOString(),
      },
      {
        jobId: jobId,
      },
    );

    appendToLogFile(
      `[ENQUEUE] ${image}: New job ${jobId} buffered to Redis queue`,
    );
    console.log(
      `[API] Enqueued new job ${jobId} to Redis queue for image "${image}"`,
    );
    return res.status(201).json({ id: jobId, status: "pending", image });
  } catch (err: any) {
    console.error("[API] Failed to enqueue job to Redis:", err);
    return res.status(500).json({ error: "Queue error creating job" });
  }
}

// GET /jobs - Fetch all jobs and sign presigned S3 URLs
export async function getAllJobsHandler(_req: Request, res: Response) {
  try {
    const rows = await getAllJobs();
    const formatted = await Promise.all(
      rows.map(async (r) => {
        let thumbnail = r.thumbnail || null;
        if (thumbnail) {
          try {
            const s3Key = thumbnail.includes("amazonaws.com/")
              ? thumbnail.split(".com/")[1]
              : thumbnail;

            if (s3Key.startsWith("thumbnails/")) {
              thumbnail = await getPresignedDownloadUrl(s3Key, 3600);
            }
          } catch (e) {
            console.error(
              `[API] Error generating presigned URL for ${thumbnail}:`,
              e,
            );
          }
        }
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          workerId: r.worker_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          payload: {
            image: r.image,
            originalName: r.original_name,
            thumbnail,
            metrics: r.metrics,
            error: r.error_message,
          },
        };
      }),
    );
    return res.status(200).json(formatted);
  } catch (err) {
    console.error("[API] Error fetching jobs from Neon DB:", err);
    return res.status(500).json({ error: "Failed to fetch jobs" });
  }
}

// GET /jobs/:id - Fetch single job by ID
export async function getJobByIdHandler(req: Request, res: Response) {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const r = await getJobById(id);
    if (!r) {
      return res.status(404).json({ error: "Job not found" });
    }
    return res.status(200).json({
      id: r.id,
      type: r.type,
      status: r.status,
      workerId: r.worker_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      payload: {
        image: r.image,
        originalName: r.original_name,
        thumbnail: r.thumbnail,
        metrics: r.metrics,
        error: r.error_message,
      },
    });
  } catch (err) {
    console.error("[API] Error fetching job from Neon DB:", err);
    return res.status(500).json({ error: "Database error" });
  }
}

// DELETE /jobs - Delete selected jobs or clear all finished jobs
export async function deleteJobsHandler(req: Request, res: Response) {
  try {
    const { ids } = req.body || {};
    let deletedThumbnails: string[] = [];

    if (Array.isArray(ids) && ids.length > 0) {
      deletedThumbnails = await deleteJobsByIds(ids);
      console.log(`[API] Deleted ${ids.length} selected job(s) from Neon DB`);
      appendToLogFile(`[DELETE] Deleted ${ids.length} selected job(s)`);
    } else {
      deletedThumbnails = await deleteAllFinishedJobs();
      console.log(`[API] Cleared all finished jobs from Neon DB`);
      appendToLogFile(`[DELETE] Cleared all finished jobs`);
    }

    // Clean up corresponding objects in S3
    for (const thumb of deletedThumbnails) {
      if (thumb && thumb.startsWith("thumbnails/")) {
        await deleteFileFromS3(thumb);
      }
    }

    return res.status(200).json({
      message: "Jobs deleted successfully",
      count: deletedThumbnails.length,
    });
  } catch (err) {
    console.error("[API] Error deleting jobs:", err);
    return res.status(500).json({ error: "Failed to delete jobs" });
  }
}

