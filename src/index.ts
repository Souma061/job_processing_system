import crypto from "crypto";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());

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
function runCpuJobOnThread(jobId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve("src/cpu-worker.ts");
    //spawn a new worker thread for the CPU-intensive task
    const worker = new Worker(workerPath, {
      workerData: { jobId },
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
// queue to hold jobs
const jobQueue: Job[] = [];
//registry holding all jobs for faster lookup by id
const jobRegustery = new Map<string, Job>();
function saveJobToFile(job: Job): void {
  try {
    const jobsArray = Array.from(jobRegustery.values());
    fs.writeFileSync(
      path.join(DATA_DIR, "jobs.json"),
      JSON.stringify(jobsArray, null, 2),
    );
  } catch (error) {
    console.error("[API] Error saving job to file:", error);
  }
}

function recoverJobsFromFile(): void {
  if (!fs.existsSync(path.join(DATA_DIR, "jobs.json"))) {
    console.log(
      "[API] No jobs.json file found, starting with an empty job registry.",
    );
    return;
  }
  try {
    const jobsData = fs.readFileSync(path.join(DATA_DIR, "jobs.json"), "utf-8");
    const jobsArray: Job[] = JSON.parse(jobsData);
    let reciveredCount = 0;
    jobsArray.forEach((job) => {
      jobRegustery.set(job.id, job);
      if (job.status === "pending" || job.status === "in-progress") {
        if (job.status === "in-progress") {
          console.log(
            `[Recovery] Resetting interrupted job ${job.id} from 'in-progress' -> 'pending'`,
          );
          job.status = "pending";
          job.updatedAt = new Date().toISOString();
        }
        jobQueue.push(job);
        reciveredCount++;
      }
    });
    saveJobToFile({} as Job); // Save the updated job statuses back to the file
    console.log(
      `[Recovery] Recovered ${reciveredCount} jobs from file. Queue depth: ${jobQueue.length}`,
    );
  } catch (error) {
    console.error("[API] Error recovering jobs from file:", error);
  }
}
// enqueue a new job
app.post("/jobs", (req: Request, res: Response) => {
  const { type, image, ...rest } = req.body;
  if (!type || !image) {
    return res
      .status(400)
      .json({ error: "Missing required fields: type and image" });
  }
  
  const job: Job = {
    id: `job-${crypto.randomUUID()}`,
    type,
    status: "pending",
    payload: { image, ...rest },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobQueue.push(job);
  jobRegustery.set(job.id, job);
  saveJobToFile(job);
  console.log(`[API] Enqueued new job ${job.id}`);
  return res.status(201).json({ id: job.id, status: job.status });
});
app.get("/jobs/:id", (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = jobRegustery.get(id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  return res.status(200).json(job);
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// the worker loop
async function processJob(job: Job, workerId: string): Promise<void> {
  job.status = "in-progress";
  job.workerId = workerId;
  job.updatedAt = new Date().toISOString();
  saveJobToFile(job);
  console.log(`[${workerId}] Started heavy CPU processing for ${job.id}...`);
  // ofload the heavy CPU processing to a separate thread to avoid blocking the main event loop
  await runCpuJobOnThread(job.id);

  job.status = "completed";
  job.updatedAt = new Date().toISOString();
  saveJobToFile(job);
  console.log(`[${workerId}] Finished CPU processing for ${job.id}`);
}

async function startWorker(workerId: string): Promise<void> {
  console.log(`[${workerId}] Worker started, polling jobs... `);
  while (true) {
    const job = jobQueue.shift();
    if (job) {
      try {
        await processJob(job, workerId);
      } catch (error) {
        job.status = "failed";
        job.updatedAt = new Date().toISOString();
        saveJobToFile(job);
        console.error(`[${workerId}] Error processing job ${job.id}:`, error);
      }
    } else {
      // if queue is empty, wait for a while before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  recoverJobsFromFile();

  // Spin up two concurrent workers!
  startWorker("Worker-1");
  startWorker("Worker-2");
});
