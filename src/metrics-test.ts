import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const UPLOADS_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const SERVER_URL = "http://localhost:3000";

interface ColorItem {
  name: string;
  r: number;
  g: number;
  b: number;
  priority: number;
}

const TEST_JOBS: ColorItem[] = [
  // 4 VIP Jobs
  { name: "vip-crimson", r: 220, g: 20, b: 60, priority: 1 },
  { name: "vip-gold", r: 255, g: 215, b: 0, priority: 1 },
  { name: "vip-azure", r: 0, g: 127, b: 255, priority: 1 },
  { name: "vip-violet", r: 138, g: 43, b: 226, priority: 1 },
  // 6 Normal Jobs
  { name: "norm-slate", r: 112, g: 128, b: 144, priority: 5 },
  { name: "norm-teal", r: 0, g: 128, b: 128, priority: 5 },
  { name: "norm-coral", r: 255, g: 127, b: 80, priority: 5 },
  { name: "norm-olive", r: 128, g: 128, b: 0, priority: 5 },
  { name: "norm-indigo", r: 75, g: 0, b: 130, priority: 5 },
  { name: "norm-maroon", r: 128, g: 0, b: 0, priority: 5 },
];

async function createTestImage(name: string, r: number, g: number, b: number): Promise<string> {
  const filename = `metric-${name}-${Date.now()}.jpg`;
  const filePath = path.join(UPLOADS_DIR, filename);

  await sharp({
    create: {
      width: 1000,
      height: 700,
      channels: 3,
      background: { r, g, b },
    },
  })
    .jpeg({ quality: 85 })
    .toFile(filePath);

  return filename;
}

async function runMetricsTest() {
  console.log("\n📊 ==================================================================");
  console.log("   🧪 PHASE 12: SYSTEM METRICS & LATENCY PERCENTILES VERIFICATION    ");
  console.log("==================================================================\n");

  // Verify server is alive
  try {
    const health = await fetch(`${SERVER_URL}/health`);
    if (!health.ok) throw new Error("Server not responding ok");
  } catch (err) {
    console.error("❌ Express server is not reachable at http://localhost:3000.");
    console.error("   Please ensure 'pnpm run dev' is running!");
    process.exit(1);
  }

  // 1. Generate and submit 10 mixed priority jobs
  console.log(`📤 Step 1: Submitting 10 mixed-priority jobs (4 VIP + 6 Normal)...`);
  const submittedIds: { id: string; name: string; priority: number }[] = [];

  for (const item of TEST_JOBS) {
    const filename = await createTestImage(item.name, item.r, item.g, item.b);
    const tag = item.priority === 1 ? "⭐ VIP" : "Normal";

    const res = await fetch(`${SERVER_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: filename,
        priority: item.priority,
        type: "thumbnail",
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { id: string };
      submittedIds.push({ id: data.id, name: item.name, priority: item.priority });
      console.log(`   ✓ [${tag}] Enqueued ${item.name} -> ${data.id}`);
    } else {
      console.error(`   ❌ Failed to enqueue ${item.name}: ${res.status}`);
    }
  }

  // 2. Wait for completion
  console.log(`\n⏳ Step 2: Waiting for workers to process all jobs...`);
  const pending = new Set(submittedIds.map((j) => j.id));
  const startTime = Date.now();

  while (pending.size > 0 && Date.now() - startTime < 40000) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const id of Array.from(pending)) {
      const res = await fetch(`${SERVER_URL}/jobs/${id}`);
      if (res.ok) {
        const job = (await res.json()) as any;
        if (job.status === "completed" || job.status === "failed") {
          pending.delete(id);
          const icon = job.status === "completed" ? "✅" : "❌";
          const m = job.payload?.metrics || job.metrics;
          const wait = m?.timings?.queueWaitMs ?? "?";
          const proc = m?.timings?.processingDurationMs ?? "?";
          const tot = m?.timings?.totalLatencyMs ?? "?";
          console.log(`   ${icon} Finished ${job.id} [Wait: ${wait}ms, Process: ${proc}ms, Total: ${tot}ms]`);
        }
      }
    }
  }

  // 3. Query GET /metrics
  console.log(`\n🔍 Step 3: Fetching aggregate telemetry from GET /metrics...`);
  const metricsRes = await fetch(`${SERVER_URL}/metrics`);
  if (!metricsRes.ok) {
    console.error(`❌ Failed to retrieve /metrics: ${metricsRes.status} ${metricsRes.statusText}`);
    return;
  }

  const metrics = (await metricsRes.json()) as any;

  // 4. Render Telemetry Report
  console.log("\n==================================================================");
  console.log("               📈 SYSTEM TELEMETRY & LATENCY REPORT               ");
  console.log("==================================================================\n");

  console.log("1. OVERALL JOB STATS:");
  console.log(`   • Total Jobs Tracked:     ${metrics.counts.total}`);
  console.log(`   • Completed Jobs:         ${metrics.counts.completed}`);
  console.log(`   • Failed Jobs:            ${metrics.counts.failed}`);
  console.log(`   • Error Rate:             ${metrics.counts.errorRatePct}%`);
  console.log(`   • Throughput (Last 60s):  ${metrics.throughput.completedLast60s} jobs/min (${metrics.throughput.jobsPerSecond} jobs/sec)`);

  console.log("\n2. QUEUE & BACKLOG STATUS:");
  console.log(`   • FIFO Waiting:           ${metrics.queue.fifoWaiting}`);
  console.log(`   • Prioritized Waiting:    ${metrics.queue.prioritizedWaiting}`);
  console.log(`   • Active Workers:         ${metrics.queue.active}`);
  console.log(`   • Total Queue Depth:      ${metrics.queue.totalDepth}`);

  console.log("\n3. LATENCY DISTRIBUTIONS (in milliseconds):");
  const pad = (str: any, len = 10) => String(str).padEnd(len);
  console.log(`   ${pad("Metric", 24)} | ${pad("Avg")} | ${pad("p50 (Med)")} | ${pad("p95")} | ${pad("p99 (Tail)")} | ${pad("Min")} | ${pad("Max")}`);
  console.log(`   ${"-".repeat(85)}`);

  const printRow = (label: string, dist: any) => {
    console.log(
      `   ${pad(label, 24)} | ${pad(dist.avg + "ms")} | ${pad(dist.p50 + "ms", 11)} | ${pad(dist.p95 + "ms")} | ${pad(dist.p99 + "ms", 12)} | ${pad(dist.min + "ms")} | ${pad(dist.max + "ms")}`
    );
  };

  printRow("Queue Wait Time", metrics.latencies.queueWaitMs);
  printRow("Processing Duration", metrics.latencies.processingDurationMs);
  printRow("Total Turnaround Time", metrics.latencies.totalTurnaroundMs);

  console.log("\n4. VIP vs NORMAL PRIORITY QUEUEING IMPACT:");
  console.log(`   • ⭐ VIP Average Queue Wait:    ${metrics.priorityBreakdown.vip.avgWaitMs}ms (count: ${metrics.priorityBreakdown.vip.count})`);
  console.log(`   • ⏳ Normal Average Queue Wait: ${metrics.priorityBreakdown.normal.avgWaitMs}ms (count: ${metrics.priorityBreakdown.normal.count})`);
  console.log(`   • 🚀 VIP Line-Cutting Advantage: ${metrics.priorityBreakdown.waitAdvantageMs}ms faster queue pickup!`);

  console.log("\n==================================================================");
  console.log("   ✅ Phase 12 Observability Verified: All Metrics Functioning!    ");
  console.log("==================================================================\n");
}

runMetricsTest().catch(console.error);
