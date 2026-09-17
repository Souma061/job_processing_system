import { type Job, UnrecoverableError, Worker } from "bullmq";
import path from "node:path";
import { Worker as ThreadWorker } from "node:worker_threads";
import {
  insertJob,
  markJobCompleted,
  markJobFailed,
  markJobInProgress,
} from "./db.js";
import { IMAGE_QUEUE_NAME, redisConnection } from "./queue.js";

// Helper: Classify if an error is permanent (do not retry) vs transient (retry)
function isPermanentError(errorMessage: string): boolean {
  const permanentPatterns = [
    /not found/i,
    /invalid format/i,
    /unsupported/i,
    /corrupt/i,
    /bad signature/i,
  ];
  return permanentPatterns.some((pattern) => pattern.test(errorMessage));
}

function runCpuJobOnThread(jobId: string, image: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve("src/cpu-worker.ts");
    const thread = new ThreadWorker(workerPath, {
      workerData: { jobId, image },
      execArgv: ["--import", "tsx"],
    });
    thread.on("message", (msg) => {
      if (msg.status === "completed") {
        resolve(msg);
      }
    });
    thread.on("error", reject);
    thread.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Thread stopped with exit code ${code}`));
      }
    });
  });
}

// Function to spawn a BullMQ worker
export function startBullWorker(workerName: string) {
  const worker = new Worker(
    IMAGE_QUEUE_NAME,
    async (job: Job) => {
      const {
        id: jobId,
        image,
        type = "thumbnail",
        originalName = image,
      } = job.data;

      const attemptNum = job.attemptsMade + 1;
      console.log(
        `[${workerName}] Claimed job ${jobId} (${image}) [Attempt ${attemptNum}/${job.opts.attempts || 3}]...`,
      );

      // 1. Idempotent upsert to Neon DB
      await insertJob(jobId, type, "in-progress", image, originalName);
      await markJobInProgress(jobId, workerName);

      try {
        // 2. Offload processing to Worker Thread
        const result = await runCpuJobOnThread(jobId, image);

        // 3. Mark completed
        await markJobCompleted(
          jobId,
          result?.outputThumbnail || "",
          result?.metrics || result?.imageLog || null,
        );
        console.log(`[${workerName}] Finished job ${jobId} successfully!`);
        return result;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);

        // 🚨 Permanent Error (Poison Pill): Abort retries immediately!
        if (isPermanentError(errorMsg)) {
          console.warn(
            `[${workerName}] Permanent error detected on job ${jobId}. Aborting retries: "${errorMsg}"`,
          );
          throw new UnrecoverableError(errorMsg);
        }

        // 🔄 Transient Error (Network/S3/DB blip): Let BullMQ retry with exponential backoff!
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency: 2,
    },
  );

  // DLQ / Final Failure Handler (Runs when attempts are exhausted or UnrecoverableError thrown)
  worker.on("failed", async (job, err) => {
    if (job) {
      const isFinalAttempt =
        job.attemptsMade >= (job.opts.attempts || 3) ||
        err.name === "UnrecoverableError";
      console.error(
        `[${workerName}] Job ${job.data.id} failed (${job.attemptsMade} attempts). Final failure: ${isFinalAttempt}`,
        err.message,
      );

      if (isFinalAttempt) {
        // Quarantined to Dead-Letter State in Database
        await markJobFailed(job.data.id, `[DLQ] ${err.message}`);
      }
    }
  });

  console.log(`[${workerName}] BullMQ worker started and connected to Redis.`);
  return worker;
}
