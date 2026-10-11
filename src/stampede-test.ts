import { calculatePercentile } from "./metrics.js";

const SERVER_URL = "http://localhost:3000";
const API_KEY = "key_std_prod_123";

// Configurable Stampede Parameters
const TOTAL_REQUESTS = 10000; // Total stampede requests
const CONCURRENCY = 200;      // Concurrent requests in flight

async function checkServerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function runStampede() {
  console.log("\n==================================================================");
  console.log("   💥 CACHE STAMPEDE TEST (CURRENT ARCHITECTURE - DIRECT TO DB)    ");
  console.log("==================================================================");
  console.log(`Target:       GET ${SERVER_URL}/metrics`);
  console.log(`Total Calls:  ${TOTAL_REQUESTS}`);
  console.log(`Concurrency:  ${CONCURRENCY} simultaneous in-flight connections`);
  console.log("------------------------------------------------------------------\n");

  const isAlive = await checkServerAlive();
  if (!isAlive) {
    console.error("❌ Express server is not reachable at http://localhost:3000.");
    console.error("   Please ensure 'pnpm run dev' is running!");
    process.exit(1);
  }

  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;
  const errors: Record<string, number> = {};

  const startTime = Date.now();
  let completed = 0;

  // Worker loop pulling from shared queue
  let requestCounter = 0;

  async function worker(workerId: number) {
    while (true) {
      const currentReq = ++requestCounter;
      if (currentReq > TOTAL_REQUESTS) break;

      const reqStart = Date.now();
      try {
        const res = await fetch(`${SERVER_URL}/metrics`, {
          headers: { "X-API-Key": API_KEY },
        });

        const duration = Date.now() - reqStart;
        latencies.push(duration);

        if (res.ok) {
          successful++;
        } else {
          failed++;
          const statusText = `HTTP ${res.status}`;
          errors[statusText] = (errors[statusText] || 0) + 1;
        }
      } catch (err: any) {
        const duration = Date.now() - reqStart;
        latencies.push(duration);
        failed++;
        const errMsg = err.code || err.message || "NetworkError";
        errors[errMsg] = (errors[errMsg] || 0) + 1;
      } finally {
        completed++;
        if (completed % 100 === 0 || completed === TOTAL_REQUESTS) {
          process.stdout.write(`\r🚀 In-flight progress: ${completed}/${TOTAL_REQUESTS} completed (${Math.round((completed / TOTAL_REQUESTS) * 100)}%)...`);
        }
      }
    }
  }

  // Launch concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const totalDurationMs = Date.now() - startTime;
  const totalDurationSec = totalDurationMs / 1000;
  const rps = (successful / totalDurationSec).toFixed(1);

  // Compute distribution
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / sorted.length);
  const min = sorted[0] || 0;
  const max = sorted[sorted.length - 1] || 0;
  const p50 = calculatePercentile(sorted, 50);
  const p95 = calculatePercentile(sorted, 95);
  const p99 = calculatePercentile(sorted, 99);

  console.log("\n\n==================================================================");
  console.log("                 📊 STAMPEDE TEST RESULTS REPORT                  ");
  console.log("==================================================================");
  console.log(`Total Requests:         ${TOTAL_REQUESTS}`);
  console.log(`Successful (200 OK):    ${successful}`);
  console.log(`Failed / Errors:        ${failed}`);
  console.log(`Total Wall Clock Time:  ${totalDurationSec.toFixed(2)}s`);
  console.log(`Throughput (RPS):       ${rps} requests/second`);

  if (failed > 0) {
    console.log("\nError Breakdown:");
    for (const [err, count] of Object.entries(errors)) {
      console.log(`   • ${err}: ${count} occurrences`);
    }
  }

  console.log("\nLatency Distribution (Every request forced a PostgreSQL percentile_cont query):");
  console.log(`   • Avg Latency:        ${avg}ms`);
  console.log(`   • Median (p50):       ${p50}ms`);
  console.log(`   • 95th Percentile:    ${p95}ms`);
  console.log(`   • 99th Percentile:    ${p99}ms (Tail Latency under stampede)`);
  console.log(`   • Min Latency:        ${min}ms`);
  console.log(`   • Max Latency:        ${max}ms`);
  console.log("==================================================================\n");
}

runStampede().catch(console.error);

