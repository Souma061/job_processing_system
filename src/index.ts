import crypto from "crypto";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import fs from "fs";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import path from "path";
import {
  deleteAllFinishedJobs,
  deleteJobsByIds,
  findInFlightJobByImage,
  getAllJobs,
  getJobById,
  initDb,
  insertJob,
  markJobCompleted,
  markJobFailed,
  markJobInProgress,
  recoverJobsFromDatabase,
} from "./db.js";
import { deleteFileFromS3, getPresignedDownloadUrl } from "./s3.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const UPLOADS_DIR = path.resolve("uploads");
const OUTPUT_DIR = path.resolve("output");
const LOGS_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOGS_DIR, "jobs.log");

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Append-only structured log file helper
function appendToLogFile(entry: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${entry}\n`, "utf-8");
  } catch (err) {
    console.error("[Logger] Failed to write to log file:", err);
  }
}

// Multer storage for handling real file uploads from frontend
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "");
    cb(null, `${base || "image"}-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });
app.use(express.json());
app.use(express.static("public"));
app.use("/output", express.static("output"));
app.use("/uploads", express.static("uploads"));
// in-memory data structure to store jobs
type JobStatus = "pending" | "in-progress" | "completed" | "failed";
interface Job {
  id: string;
  type: string;
  status: JobStatus;
  payload: {
    image: string;
    [key: string]: unknown;
  };
  workerId?: string;
  createdAt: string;
  updatedAt: string;
}

// helper function to run the cpu worker in a separate thread
function runCpuJobOnThread(jobId: string, image: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve("src/cpu-worker.ts");
    //spawn a new worker thread for the CPU-intensive task
    const worker = new Worker(workerPath, {
      workerData: { jobId, image },
      execArgv: ["--import", "tsx"],
    });
    worker.on("message", (message) => {
      if (message.status === "completed") {
        resolve(message);
      }
    });
    worker.on("error", (error) => {
      reject(error);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}
// in-memory queue to hold pending jobs for workers
const jobQueue: Job[] = [];

// Startup recovery from Neon PostgreSQL
async function recoverJobs(): Promise<void> {
  try {
    const pendingJobs = await recoverJobsFromDatabase();
    for (const row of pendingJobs) {
      jobQueue.push({
        id: row.id,
        type: row.type,
        status: "pending",
        workerId: row.worker_id || undefined,
        payload: {
          image: row.image,
          originalName: row.original_name || row.image,
          thumbnail: row.thumbnail || undefined,
          metrics: row.metrics || undefined,
        },
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      });
      appendToLogFile(
        `[RECOVERY] ${row.id}: Job recovered from Neon DB and re-queued`,
      );
    }
    console.log(
      `[Postgres] Recovered ${pendingJobs.length} jobs from Neon DB. Queue depth: ${jobQueue.length}`,
    );
  } catch (err) {
    console.error("[Postgres] Error recovering jobs from Neon DB:", err);
  }
}

// enqueue a new job (supports both multipart file upload and JSON)
app.post(
  "/jobs",
  upload.single("imageFile"),
  async (req: Request, res: Response) => {
    const image = req.file ? req.file.filename : req.body.image;
    const type = req.body.type || "thumbnail";
    const originalName = req.file ? req.file.originalname : image;

    if (!image) {
      return res.status(400).json({
        error:
          "No image provided. Please select an image file or provide an image name.",
      });
    }

    try {
      // 🔍 Deduplication check via SQL in Neon PostgreSQL
      const existingJob = await findInFlightJobByImage(image);
      if (existingJob) {
        console.log(
          `[API] Duplicate detected for image "${image}". Reusing job ${existingJob.id}`,
        );
        return res.status(200).json({
          message: "Duplicate job detected. Reusing existing job.",
          id: existingJob.id,
          status: existingJob.status,
        });
      }

      const jobId = `job-${crypto.randomUUID()}`;
      await insertJob(jobId, type, "pending", image, originalName);

      const job: Job = {
        id: jobId,
        type,
        status: "pending",
        payload: { image, originalName },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      jobQueue.push(job);
      appendToLogFile(
        `[ENQUEUE] ${image}: New job ${jobId} created in Neon DB`,
      );
      console.log(
        `[API] Enqueued new job ${jobId} in Neon DB for image "${image}"`,
      );
      return res.status(201).json({ id: jobId, status: "pending", image });
    } catch (err) {
      console.error("[API] Failed to insert job into Neon DB:", err);
      return res.status(500).json({ error: "Database error creating job" });
    }
  },
);

app.get("/jobs", async (_req: Request, res: Response) => {
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
          // thumbnail = null;
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
});

// Delete jobs: supports selected array of IDs via body { ids: [...] }, or all finished jobs if no ids provided
app.delete("/jobs", async (req: Request, res: Response) => {
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

    // Also clean up their corresponding objects in S3
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
});

app.get("/jobs/:id", async (req: Request, res: Response) => {
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
});

app.get("/health", async (_req: Request, res: Response) => {
  try {
    const jobs = await getAllJobs();
    res.status(200).json({
      status: "ok",
      database: "connected (Neon PostgreSQL)",
      queueDepth: jobQueue.length,
      totalJobs: jobs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

// Endpoint to stream recent lines from logs/jobs.log for the frontend
app.get("/logs", (_req: Request, res: Response) => {
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
});

// the worker loop
async function processJob(job: Job, workerId: string): Promise<void> {
  job.status = "in-progress";
  job.workerId = workerId;
  job.updatedAt = new Date().toISOString();

  // 1. Update status to in-progress in Neon PostgreSQL
  await markJobInProgress(job.id, workerId);
  console.log(
    `[${workerId}] Started image processing for ${job.id} (${job.payload.image})...`,
  );
  appendToLogFile(
    `[IN-PROGRESS] [${workerId}] ${job.id} (${job.payload.image}): Started processing`,
  );

  // offload the heavy CPU processing to a separate thread to avoid blocking the main event loop
  const result = await runCpuJobOnThread(job.id, job.payload.image);

  job.status = "completed";
  job.updatedAt = new Date().toISOString();
  if (result?.outputThumbnail) {
    job.payload.thumbnail = result.outputThumbnail;
  }
  const metrics = result?.metrics || result?.imageLog;
  if (metrics) {
    job.payload.metrics = metrics;
  }

  // 2. Mark completed with thumbnail and metrics in Neon PostgreSQL
  await markJobCompleted(
    job.id,
    result?.outputThumbnail || "",
    metrics || null,
  );
  console.log(
    `[${workerId}] Finished image processing for ${job.id} and saved to Neon DB`,
  );

  // Append full metrics line to logs/jobs.log
  if (metrics) {
    const origSize =
      metrics.original?.sizeFormatted || metrics.original?.size || "unknown";
    const thumbSize =
      metrics.thumbnail?.sizeFormatted || metrics.thumbnail?.size || "unknown";
    const origDims = `${metrics.original?.width || 0}x${metrics.original?.height || 0}`;
    const thumbDims = `${metrics.thumbnail?.width || 150}x${metrics.thumbnail?.height || 150}`;
    const red = metrics.reduction ? `[${metrics.reduction}] ` : "";
    const dur =
      metrics.durationMs !== undefined ? `${metrics.durationMs}ms` : "";

    appendToLogFile(
      `[SUCCESS] [${workerId}] ${job.id} (${job.payload.image}): ` +
        `${origSize} (${origDims}) -> ${thumbSize} (${thumbDims}) ` +
        `${red}in ${dur}`,
    );
  } else {
    appendToLogFile(
      `[SUCCESS] [${workerId}] ${job.id} (${job.payload.image}) completed`,
    );
  }
}

async function startWorker(workerId: string): Promise<void> {
  console.log(`[${workerId}] Worker started, polling jobs... `);
  while (true) {
    const job = jobQueue.shift();
    if (job) {
      try {
        await processJob(job, workerId);
      } catch (error: any) {
        job.status = "failed";
        job.updatedAt = new Date().toISOString();
        // Record failure in Neon PostgreSQL
        await markJobFailed(job.id, error?.message || String(error));
        console.error(`[${workerId}] Error processing job ${job.id}:`, error);
        appendToLogFile(
          `[FAILED] [${workerId}] ${job.id} (${job.payload.image}): ${error?.message || error}`,
        );
      }
    } else {
      // if queue is empty, wait for a while before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  // 1. Initialize schema in Neon PostgreSQL
  await initDb();
  // 2. Recover interrupted/pending jobs from Neon PostgreSQL
  await recoverJobs();

  // Spin up three concurrent workers!
  startWorker("Worker-1");
  startWorker("Worker-2");
  // startWorker("Worker-3");
});
