import { getAggregatedSystemMetricsFromDb } from "./db.js";
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

export async function getSystemMetrics(windowHours?: number): Promise<SystemMetrics> {
  // 1. BullMQ Real-time Queue State
  const fifoWaiting = await imageQueue.getWaitingCount();
  const prioritizedWaiting = await imageQueue.getPrioritizedCount();
  const totalWaiting = fifoWaiting + prioritizedWaiting;
  const active = await imageQueue.getActiveCount();
  const delayed = await imageQueue.getDelayedCount();
  const totalDepth = totalWaiting + active;

  // 2. High-performance aggregated metrics directly from PostgreSQL (percentile_cont pushdown)
  const dbData = await getAggregatedSystemMetricsFromDb(windowHours);

  const total = dbData.totalCount;
  const errorRatePct = total > 0 ? Number(((dbData.failedCount / total) * 100).toFixed(1)) : 0;

  return {
    counts: {
      total,
      completed: dbData.completedCount,
      failed: dbData.failedCount,
      inProgress: dbData.inProgressCount,
      pending: dbData.pendingCount,
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
      completedLast60s: dbData.completedLast60s,
      jobsPerMinute: dbData.completedLast60s,
      jobsPerSecond: Number((dbData.completedLast60s / 60).toFixed(2)),
    },
    latencies: {
      totalTurnaroundMs: dbData.totalTurnaround,
      queueWaitMs: dbData.queueWait,
      processingDurationMs: dbData.processingDuration,
    },
    priorityBreakdown: dbData.priorityBreakdown,
    timestamp: new Date().toISOString(),
  };
}

