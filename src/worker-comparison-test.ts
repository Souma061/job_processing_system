import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { startBullWorker } from "./worker.js";
import { calculatePercentile } from "./metrics.js";

const UPLOADS_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const SERVER_URL = "http://localhost:3000";
const BATCH_SIZE = 8; // 8 image jobs per run

async function createTestImage(prefix: string, index: number): Promise<string> {
  const filename = `cmp-${prefix}-${index}-${Date.now()}.jpg`;
  const filePath = path.join(UPLOADS_DIR, filename);

  const r = (index * 30 + 50) % 255;
  const g = (index * 50 + 80) % 255;
  const b = (index * 70 + 110) % 255;

  await sharp({
    create: {
      width: 1000,
      height: 700,
      channels: 3,
      background: { r, g, b },
    },
  })
    .jpeg({ quality: 80 })
    .toFile(filePath);

  return filename;
}

interface RunStats {
  label: string;
  workerCount: number;
  totalBatchDurationMs: number;
  throughputJobsPerSec: number;
  waitTimes: {
    avg: number;
    p50: number;
    p95: number;
    min: number;
    max: number;
  };
  processTimes: { avg: number; p50: number; p95: number };
  turnaroundTimes: {
    avg: number;
    p50: number;
    p95: number;
    min: number;
    max: number;
  };
  workerDistribution: Record<string, number>;
}

async function executeBatchRun(
  label: string,
  prefix: string,
  workerCount: number,
): Promise<RunStats> {
  console.log(
    `\n==================================================================`,
  );
  console.log(
    `   🚀 EXECUTING: ${label.toUpperCase()} (${workerCount} Active Worker${workerCount > 1 ? "s" : ""})`,
  );
  console.log(
    `==================================================================`,
  );

  // 1. Prepare images
  console.log(`📸 Creating ${BATCH_SIZE} unique test images...`);
  const imageNames: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    imageNames.push(await createTestImage(prefix, i));
  }

  // 2. Enqueue in quick burst
  console.log(`📨 Submitting burst of ${BATCH_SIZE} jobs to POST /jobs...`);
  const jobIds: string[] = [];
  const batchStartTime = Date.now();

  for (let i = 0; i < imageNames.length; i++) {
    const priority = i % 2 === 0 ? 1 : 5; // 50% VIP, 50% Normal
    const res = await fetch(`${SERVER_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageNames[i],
        priority,
        type: "thumbnail",
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { id: string };
      jobIds.push(data.id);
    }
  }

  // 3. Poll until all jobs in batch are completed
  console.log(
    `⏳ Monitoring execution until all ${jobIds.length} jobs complete...`,
  );
  const pending = new Set(jobIds);
  const completedJobs: any[] = [];

  while (pending.size > 0 && Date.now() - batchStartTime < 60000) {
    await new Promise((r) => setTimeout(r, 800));

    for (const id of Array.from(pending)) {
      const res = await fetch(`${SERVER_URL}/jobs/${id}`);
      if (res.ok) {
        const job = (await res.json()) as any;
        if (job.status === "completed" || job.status === "failed") {
          pending.delete(id);
          completedJobs.push(job);
          const worker = job.workerId || "worker";
          const m = job.payload?.metrics || job.metrics;
          const wait = m?.timings?.queueWaitMs ?? "?";
          const proc = m?.timings?.processingDurationMs ?? "?";
          console.log(
            `   ✓ [${worker}] Completed ${id} (Wait: ${wait}ms, Process: ${proc}ms)`,
          );
        }
      }
    }
  }

  const batchEndTime = Date.now();
  const totalBatchDurationMs = batchEndTime - batchStartTime;

  // 4. Extract latencies
  const waitList: number[] = [];
  const procList: number[] = [];
  const totalList: number[] = [];
  const workerDist: Record<string, number> = {};

  for (const job of completedJobs) {
    const worker = job.workerId || "Unknown";
    workerDist[worker] = (workerDist[worker] || 0) + 1;

    const m = job.payload?.metrics || job.metrics;
    if (m?.timings) {
      if (typeof m.timings.queueWaitMs === "number")
        waitList.push(m.timings.queueWaitMs);
      if (typeof m.timings.processingDurationMs === "number")
        procList.push(m.timings.processingDurationMs);
      if (typeof m.timings.totalLatencyMs === "number")
        totalList.push(m.timings.totalLatencyMs);
    }
  }

  const sortNum = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  const sortedWait = sortNum(waitList);
  const sortedProc = sortNum(procList);
  const sortedTotal = sortNum(totalList);

  const throughput = Number(
    (BATCH_SIZE / (totalBatchDurationMs / 1000)).toFixed(2),
  );

  return {
    label,
    workerCount,
    totalBatchDurationMs,
    throughputJobsPerSec: throughput,
    waitTimes: {
      avg: avg(sortedWait),
      p50: calculatePercentile(sortedWait, 50),
      p95: calculatePercentile(sortedWait, 95),
      min: sortedWait[0] ?? 0,
      max: sortedWait[sortedWait.length - 1] ?? 0,
    },
    processTimes: {
      avg: avg(sortedProc),
      p50: calculatePercentile(sortedProc, 50),
      p95: calculatePercentile(sortedProc, 95),
    },
    turnaroundTimes: {
      avg: avg(sortedTotal),
      p50: calculatePercentile(sortedTotal, 50),
      p95: calculatePercentile(sortedTotal, 95),
      min: sortedTotal[0] ?? 0,
      max: sortedTotal[sortedTotal.length - 1] ?? 0,
    },
    workerDistribution: workerDist,
  };
}

async function runComparison() {
  console.log(
    "\n==================================================================",
  );
  console.log(
    "   🧪 BENCHMARK: SINGLE WORKER VS. MULTI-WORKER COMPARISON        ",
  );
  console.log(
    "==================================================================\n",
  );

  // Verify server
  try {
    const h = await fetch(`${SERVER_URL}/health`);
    if (!h.ok) throw new Error();
  } catch {
    console.error(
      "❌ Express server not responding on http://localhost:3000. Start with 'pnpm run dev' first.",
    );
    process.exit(1);
  }

  // --- RUN 1: SINGLE WORKER ---
  console.log("👉 Test 1/2: Running with 1 Worker (Worker-3000)...");
  const singleStats = await executeBatchRun("Single Worker", "single", 1);

  // Pause briefly
  await new Promise((r) => setTimeout(r, 2000));

  // --- RUN 2: MULTI-WORKER (Add 2 more workers to cluster) ---
  console.log(
    "\n👉 Test 2/2: Launching 2 Additional Dynamic Workers (Worker-Cluster-A, Worker-Cluster-B)...",
  );
  const workerA = startBullWorker("Worker-Cluster-A", 2);
  const workerB = startBullWorker("Worker-Cluster-B", 2);
  await new Promise((r) => setTimeout(r, 1000)); // allow workers to register on Redis

  const multiStats = await executeBatchRun(
    "Multi-Worker Cluster (3 Workers)",
    "multi",
    3,
  );

  // Stop dynamic workers
  console.log("\n🧹 Gracefully stopping dynamic cluster workers...");
  await workerA.close();
  await workerB.close();

  // --- COMPARATIVE SCORECARD ---
  console.log(
    "\n==================================================================",
  );
  console.log(
    "           📊 FINAL COMPARATIVE BENCHMARK SCORECARD               ",
  );
  console.log(
    "==================================================================\n",
  );

  const pad = (s: any, len = 26) => String(s).padEnd(len);
  const padR = (s: any, len = 18) => String(s).padStart(len);

  console.log(
    `${pad("METRIC")} | ${padR("1 WORKER")} | ${padR("3 WORKERS")} | ${padR("IMPROVEMENT")}`,
  );
  console.log("-".repeat(85));

  // Batch Total Drain Time
  const drainSingle =
    (singleStats.totalBatchDurationMs / 1000).toFixed(1) + " s";
  const drainMulti = (multiStats.totalBatchDurationMs / 1000).toFixed(1) + " s";
  const speedup =
    (
      singleStats.totalBatchDurationMs / multiStats.totalBatchDurationMs
    ).toFixed(1) + "x faster";
  console.log(
    `${pad("Total Batch Drain Time")} | ${padR(drainSingle)} | ${padR(drainMulti)} | ${padR("🚀 " + speedup)}`,
  );

  // Throughput
  const tpSingle = singleStats.throughputJobsPerSec + " jobs/s";
  const tpMulti = multiStats.throughputJobsPerSec + " jobs/s";
  const tpGain =
    "+" +
    (
      (multiStats.throughputJobsPerSec / singleStats.throughputJobsPerSec - 1) *
      100
    ).toFixed(0) +
    "%";
  console.log(
    `${pad("Throughput (jobs/sec)")} | ${padR(tpSingle)} | ${padR(tpMulti)} | ${padR("⚡ " + tpGain)}`,
  );

  // Average Queue Wait
  const waitAvgSingle = singleStats.waitTimes.avg + " ms";
  const waitAvgMulti = multiStats.waitTimes.avg + " ms";
  const waitReduction =
    "-" +
    ((1 - multiStats.waitTimes.avg / singleStats.waitTimes.avg) * 100).toFixed(
      1,
    ) +
    "%";
  console.log(
    `${pad("Avg Queue Wait Time")} | ${padR(waitAvgSingle)} | ${padR(waitAvgMulti)} | ${padR("📉 " + waitReduction)}`,
  );

  // Median (p50) Queue Wait
  const waitP50Single = singleStats.waitTimes.p50 + " ms";
  const waitP50Multi = multiStats.waitTimes.p50 + " ms";
  console.log(
    `${pad("Median (p50) Queue Wait")} | ${padR(waitP50Single)} | ${padR(waitP50Multi)} | ${padR("-" + (singleStats.waitTimes.p50 - multiStats.waitTimes.p50) + " ms")}`,
  );

  // 95th Percentile (p95) Turnaround
  const turnP95Single = singleStats.turnaroundTimes.p95 + " ms";
  const turnP95Multi = multiStats.turnaroundTimes.p95 + " ms";
  const turnDrop =
    "-" +
    (
      (1 - multiStats.turnaroundTimes.p95 / singleStats.turnaroundTimes.p95) *
      100
    ).toFixed(1) +
    "%";
  console.log(
    `${pad("p95 Turnaround (Tail)")} | ${padR(turnP95Single)} | ${padR(turnP95Multi)} | ${padR("🎯 " + turnDrop)}`,
  );

  // Processing Time (Sharp)
  const procAvgSingle = singleStats.processTimes.avg + " ms";
  const procAvgMulti = multiStats.processTimes.avg + " ms";
  console.log(
    `${pad("Avg Processing Time")} | ${padR(procAvgSingle)} | ${padR(procAvgMulti)} | ${padR("≈ identical")}`,
  );

  console.log(
    "\n------------------------------------------------------------------",
  );
  console.log("WORKER LOAD DISTRIBUTION (Multi-Worker Test):");
  for (const [wName, count] of Object.entries(multiStats.workerDistribution)) {
    console.log(
      `   • ${pad(wName, 22)}: processed ${count} jobs (${((count / BATCH_SIZE) * 100).toFixed(0)}%)`,
    );
  }
  console.log(
    "==================================================================\n",
  );
}

runComparison().catch(console.error);
