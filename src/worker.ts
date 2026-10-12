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
import { logger } from "./logger.js";

// classify error messages to determine if they are permanent (poison pill) or transient (retryable)
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

import fs from "node:fs";

function runCpuJobOnThread(jobId: string, image: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const isProduction =
      process.env.NODE_ENV === "production" ||
      !fs.existsSync(path.resolve("src/cpu-worker.ts"));
    const workerPath = isProduction
      ? path.resolve("dist/cpu-worker.js")
      : path.resolve("src/cpu-worker.ts");

    const execArgv = isProduction ? [] : ["--import", "tsx"];

    const thread = new ThreadWorker(workerPath, {
      workerData: { jobId, image },
      execArgv,
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
export function startBullWorker(workerName: string, concurrency: number = 2) {
  const worker = new Worker(
    IMAGE_QUEUE_NAME,
    async (job: Job) => {
      const {
        id: jobId,
        image,
        type = "thumbnail",
        originalName = image,
        priority = 5, // Default priority is 5 (lower number = higher priority)
        correlationId,
      } = job.data;

      const attemptNum = job.attemptsMade + 1;
      const startedAt = Date.now();
      const enqueuedAt = job.timestamp || job.data.enqueuedAt || startedAt;
      const queueWaitMs = Math.max(0, startedAt - enqueuedAt);

      logger.info(
        "WORKER",
        `Claimed job (${image}) [Priority ${priority}, Waited: ${queueWaitMs}ms]`,
        {
          correlationId,
          jobId,
          workerId: workerName,
          priority,
          queueWaitMs,
        },
      );
      // 1. Idempotent upsert to Neon DB
      await insertJob(jobId, type, "in-progress", image, originalName);
      await markJobInProgress(jobId, workerName);

      try {
        // 2. Offload processing to Worker Thread
        const result = await runCpuJobOnThread(jobId, image);
        const completedAt = Date.now();
        const processingDurationMs = completedAt - startedAt;
        const totalLatencyMs = completedAt - enqueuedAt;

        // Phase 12: Comprehensive Telemetry & Latency Metrics
        const jobMetrics = {
          timings: {
            enqueuedAt,
            startedAt,
            completedAt,
            queueWaitMs,
            processingDurationMs,
            totalLatencyMs,
          },
          priority,
          attempts: attemptNum,
          workerId: workerName,
          correlationId,
          image: result?.imageLog || null,
        };

        // 3. Mark completed with structured telemetry
        await markJobCompleted(
          jobId,
          result?.outputThumbnail || "",
          jobMetrics,
        );
        logger.info(
          "WORKER",
          `Finished job successfully (Wait: ${queueWaitMs}ms, Process: ${processingDurationMs}ms, Total: ${totalLatencyMs}ms)`,
          {
            correlationId,
            jobId,
            workerId: workerName,
            durationMs: processingDurationMs,
            totalLatencyMs,
          },
        );
        return result;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        const failedAt = Date.now();
        const failureMetrics = {
          timings: {
            enqueuedAt,
            startedAt,
            failedAt,
            queueWaitMs,
            durationBeforeFailureMs: failedAt - startedAt,
          },
          priority,
          attempts: attemptNum,
          workerId: workerName,
          correlationId,
          error: errorMsg,
        };

        // 🚨 Permanent Error (Poison Pill): Abort retries immediately!
        if (isPermanentError(errorMsg)) {
          logger.error(
            "WORKER",
            `Permanent error detected: "${errorMsg}". Aborting retries.`,
            {
              correlationId,
              jobId,
              workerId: workerName,
              error: err,
            },
          );
          await markJobFailed(jobId, `[DLQ] ${errorMsg}`, failureMetrics);
          throw new UnrecoverableError(errorMsg);
        }

        logger.warn(
          "WORKER",
          `Transient error on job, retrying: "${errorMsg}"`,
          {
            correlationId,
            jobId,
            workerId: workerName,
            error: err,
          },
        );
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency,
    },
  );

  // DLQ / Final Failure Handler (Runs when attempts are exhausted)
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
        const enqueuedAt = job.timestamp || job.data?.enqueuedAt || Date.now();
        const failedAt = Date.now();
        const finalMetrics = {
          timings: {
            enqueuedAt,
            failedAt,
            totalLatencyMs: failedAt - enqueuedAt,
          },
          priority: job.data?.priority || 5,
          attempts: job.attemptsMade,
          workerId: workerName,
          error: err.message,
        };
        // Quarantined to Dead-Letter State in Database with failure metrics
        await markJobFailed(job.data.id, `[DLQ] ${err.message}`, finalMetrics);
      }
    }
  });

  console.log(`[${workerName}] BullMQ worker started and connected to Redis.`);
  return worker;
}
