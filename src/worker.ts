import { type Job, Worker } from "bullmq";
import path from "node:path";
import { Worker as ThreadWorker } from "node:worker_threads";
import {
  insertJob,
  markJobCompleted,
  markJobFailed,
  markJobInProgress,
} from "./db.js";
import { IMAGE_QUEUE_NAME, redisConnection } from "./queue.js";

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

// function to spawn a BullMQ worker
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
      console.log(
        `[${workerName}] Claimed job ${jobId} (${image}) from Redis...`,
      );

      // Controlled insertion into Neon DB (protects connection pool from bursting!)
      try {
        await insertJob(jobId, type, "in-progress", image, originalName);
        await markJobInProgress(jobId, workerName);
      } catch (dbErr: any) {
        console.warn(
          `[${workerName}] DB insert notice for ${jobId}:`,
          dbErr.message,
        );
      }

      const result = await runCpuJobOnThread(jobId, image);
      await markJobCompleted(
        jobId,
        result?.outputThumbnail || "",
        result?.metrics || result?.imageLog || null,
      );
      console.log(`[${workerName}] Finished job ${jobId} successfully!`);
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 2, // each bullmq worker can run 2 jobs simultaneously
    },
  );
  worker.on("failed", async (job, err) => {
    if (job) {
      console.error(`[${workerName}] Job ${job.id} failed:`, err);
      await markJobFailed(job.data.id, err.message || "Unknown error");
    }
  });
  console.log(`[${workerName}] BullMQ worker started and connected to Redis.`);
  return worker;
}
