import { getAllJobs, type JobRow } from "./db.js";
import { imageQueue } from "./queue.js";

export interface LatencyDistribution {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number; // Median
  p95: number; // 95th Percentile
  p99: number; // 99th Percentile (Tail Latency)
}

export interface SystemMetrics {
  counts: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    pending: number;
    errorRatePct: number;
  };
  queue: {
    fifoWaiting: number;
    prioritizedWaiting: number;
    totalWaiting: number;
    active: number;
    delayed: number;
    totalDepth: number;
  };
  throughput: {
    completedLast60s: number;
    jobsPerMinute: number;
    jobsPerSecond: number;
  };
  latencies: {
    totalTurnaroundMs: LatencyDistribution;
    queueWaitMs: LatencyDistribution;
    processingDurationMs: LatencyDistribution;
  };
  priorityBreakdown: {
    vip: {
      count: number;
      avgWaitMs: number;
      p50WaitMs: number;
    };
    normal: {
      count: number;
      avgWaitMs: number;
      p50WaitMs: number;
    };
    waitAdvantageMs: number;
  };
  timestamp: string;
}

/**
 * Computes a specific percentile from a sorted array of numbers (Nearest-Rank Method)
 */
export function calculatePercentile(sorted: number[], p: number): number {
  if (!sorted || sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(rank - 1, sorted.length - 1));
  return sorted[index];
}

function computeDistribution(values: number[]): LatencyDistribution {
  if (!values || values.length === 0) {
    return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round(sum / sorted.length);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = calculatePercentile(sorted, 50);
  const p95 = calculatePercentile(sorted, 95);
  const p99 = calculatePercentile(sorted, 99);

  return {
    count: sorted.length,
    avg,
    min,
    max,
    p50,
    p95,
    p99,
  };
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const jobs: JobRow[] = await getAllJobs();

  // 1. BullMQ Real-time Queue State
  const fifoWaiting = await imageQueue.getWaitingCount();
  const prioritizedWaiting = await imageQueue.getPrioritizedCount();
  const totalWaiting = fifoWaiting + prioritizedWaiting;
  const active = await imageQueue.getActiveCount();
  const delayed = await imageQueue.getDelayedCount();
  const totalDepth = totalWaiting + active;

  // 2. Count states
  let completedCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;
  let pendingCount = 0;

  const totalTurnaroundTimes: number[] = [];
  const queueWaitTimes: number[] = [];
  const processingDurations: number[] = [];

  const vipWaitTimes: number[] = [];
  const normalWaitTimes: number[] = [];

  const now = Date.now();
  let completedLast60s = 0;

  for (const job of jobs) {
    if (job.status === "completed") {
      completedCount++;
      const updatedAt = new Date(job.updated_at).getTime();
      if (now - updatedAt <= 60000) {
        completedLast60s++;
      }
    } else if (job.status === "failed") {
      failedCount++;
    } else if (job.status === "in-progress") {
      inProgressCount++;
    } else if (job.status === "pending") {
      pendingCount++;
    }

    // Extract metrics if available
    if (job.metrics) {
      let metricsObj = job.metrics;
      if (typeof metricsObj === "string") {
        try {
          metricsObj = JSON.parse(metricsObj);
        } catch {
          metricsObj = null;
        }
      }

      if (metricsObj?.timings) {
        const { totalLatencyMs, queueWaitMs, processingDurationMs } = metricsObj.timings;
        if (typeof totalLatencyMs === "number" && totalLatencyMs >= 0) {
          totalTurnaroundTimes.push(totalLatencyMs);
        }
        if (typeof queueWaitMs === "number" && queueWaitMs >= 0) {
          queueWaitTimes.push(queueWaitMs);
          const priority = metricsObj.priority || 5;
          if (priority === 1) {
            vipWaitTimes.push(queueWaitMs);
          } else {
            normalWaitTimes.push(queueWaitMs);
          }
        }
        if (typeof processingDurationMs === "number" && processingDurationMs >= 0) {
          processingDurations.push(processingDurationMs);
        }
      }
    }
  }

  const total = jobs.length;
  const errorRatePct = total > 0 ? Number(((failedCount / total) * 100).toFixed(1)) : 0;

  // 3. Compute distributions
  const totalDist = computeDistribution(totalTurnaroundTimes);
  const waitDist = computeDistribution(queueWaitTimes);
  const processDist = computeDistribution(processingDurations);

  // 4. Priority breakdown
  const vipDist = computeDistribution(vipWaitTimes);
  const normalDist = computeDistribution(normalWaitTimes);
  const waitAdvantageMs = Math.max(0, normalDist.avg - vipDist.avg);

  return {
    counts: {
      total,
      completed: completedCount,
      failed: failedCount,
      inProgress: inProgressCount,
      pending: pendingCount,
      errorRatePct,
    },
    queue: {
      fifoWaiting,
      prioritizedWaiting,
      totalWaiting,
      active,
      delayed,
      totalDepth,
    },
    throughput: {
      completedLast60s,
      jobsPerMinute: completedLast60s,
      jobsPerSecond: Number((completedLast60s / 60).toFixed(2)),
    },
    latencies: {
      totalTurnaroundMs: totalDist,
      queueWaitMs: waitDist,
      processingDurationMs: processDist,
    },
    priorityBreakdown: {
      vip: {
        count: vipWaitTimes.length,
        avgWaitMs: vipDist.avg,
        p50WaitMs: vipDist.p50,
      },
      normal: {
        count: normalWaitTimes.length,
        avgWaitMs: normalDist.avg,
        p50WaitMs: normalDist.p50,
      },
      waitAdvantageMs,
    },
    timestamp: new Date().toISOString(),
  };
}

