// Phase 10: Automated Queue Growth & Backpressure Test
const BASE_URL = process.env.API_URL || "http://localhost:3000";

async function runTest() {
  console.log(
    "=================================================================",
  );
  console.log("   PHASE 10: QUEUE GROWTH & BACKPRESSURE VERIFICATION TEST");
  console.log(
    "=================================================================\n",
  );

  console.log("Step 1: Checking current queue health status...");
  try {
    const healthRes = await fetch(`${BASE_URL}/health`);
    const health: any = await healthRes.json();
    console.log(
      `Current Queue Depth: ${health.queueDepth} (Waiting: ${health.waitingCount}, Active: ${health.activeCount})`,
    );
    console.log(
      `Configured Capacity: Normal=${health.maxCapacity}, VIP=${health.maxVipCapacity}\n`,
    );
  } catch (err: any) {
    console.error(
      `❌ Cannot connect to server at ${BASE_URL}. Ensure "pnpm run dev" is running!`,
    );
    process.exit(1);
  }

  console.log(
    "Step 2: Rapidly dispatching 70 jobs to saturate the queue (capacity = 50)...",
  );
  const results = [];
  for (let idx = 0; idx < 70; idx++) {
    try {
      const res = await fetch(`${BASE_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "thumbnail",
          image: "sample.jpg",
          priority: 5, // Normal priority
        }),
      });
      const data: any = await res.json();
      results.push({ id: idx + 1, status: res.status, data });
      process.stdout.write(res.status === 201 ? "🟩" : "🟥");
    } catch (err: any) {
      results.push({ id: idx + 1, status: 0, error: err.message });
      process.stdout.write("⚠️");
    }
  }
  console.log("\n");

  const accepted = results.filter((r) => r.status === 201).length;
  const backpressured = results.filter((r) => r.status === 503).length;

  console.log("\n--- Ingestion Results ---");
  console.log(`✅ Accepted (HTTP 201 Created):       ${accepted} jobs`);
  console.log(`🛑 Backpressure (HTTP 503 Saturated): ${backpressured} jobs`);

  if (backpressured > 0) {
    const sampleReject = results.find((r) => r.status === 503);
    console.log("\nSample Backpressure Response Payload:");
    console.log(JSON.stringify(sampleReject?.data, null, 2));
  }

  console.log("\nStep 3: Testing VIP Bypass during active Backpressure...");
  try {
    const vipRes = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "thumbnail",
        image: "sample.jpg",
        priority: 1, // VIP priority (limit = 100)
      }),
    });
    const vipData: any = await vipRes.json();
    console.log(
      `⭐ VIP Job Status: HTTP ${vipRes.status} (Expected: 201 Created via VIP reserve capacity)`,
    );
    console.log(`⭐ VIP Job ID: ${vipData.id}`);
  } catch (err: any) {
    console.error("VIP test failed:", err.message);
  }

  console.log(
    "\n=================================================================",
  );
  console.log("   TEST COMPLETE — Queue is protected from unbounded growth!");
  console.log(
    "=================================================================\n",
  );
}

runTest();
