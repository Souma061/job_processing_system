import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SERVER_URL = "http://localhost:3000";
const UPLOADS_DIR = path.resolve("uploads");

async function createValidImage(name: string) {
  const filePath = path.join(UPLOADS_DIR, name);
  await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 50, g: 150, b: 200 },
    },
  })
    .jpeg()
    .toFile(filePath);
}

async function runChaosTest() {
  console.log("\n==================================================================");
  console.log("   💥 EXPERIMENT: CONCURRENT REQUESTS WITHOUT CORRELATION ID      ");
  console.log("==================================================================\n");

  // Create 2 valid images
  await createValidImage("valid-cat.jpg");
  await createValidImage("valid-dog.jpg");

  // Define 5 concurrent requests from 5 different users
  const requests = [
    { user: "Alice", image: "valid-cat.jpg", note: "Should succeed" },
    { user: "Bob (Attacker/Bug)", image: "ghost-missing-1.jpg", note: "Missing file -> Fatal error!" },
    { user: "Charlie", image: "valid-dog.jpg", note: "Should succeed" },
    { user: "Dave (Bug)", image: "ghost-missing-2.jpg", note: "Missing file -> Fatal error!" },
    { user: "Eve", image: "valid-cat.jpg", note: "Should succeed" },
  ];

  console.log("👥 5 Users submitting images at the exact same moment:\n");
  requests.forEach((r) => console.log(`   • ${r.user.padEnd(20)} -> Image: ${r.image.padEnd(22)} (${r.note})`));

  console.log("\n🚀 Firing all 5 requests concurrently via Promise.all()...");

  const responses = await Promise.all(
    requests.map(async (r) => {
      const res = await fetch(`${SERVER_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: r.image, priority: 5 }),
      });
      const data = (await res.json()) as any;
      return { user: r.user, image: r.image, status: res.status, data };
    })
  );

  console.log("\n📬 HTTP Responses returned to users:");
  responses.forEach((resp) => {
    console.log(`   • ${resp.user.padEnd(20)} -> HTTP ${resp.status} (Job ID: ${resp.data?.id || "N/A"})`);
  });

  // Wait 4 seconds for workers to process in background
  console.log("\n⏳ Workers are running concurrently in background... waiting 4 seconds...\n");
  await new Promise((r) => setTimeout(r, 4000));

  // Fetch recent server logs from GET /logs
  const logsRes = await fetch(`${SERVER_URL}/logs`);
  const logs = (await logsRes.json()) as string[];
  const recentLogs = logs.slice(-15);

  console.log("==================================================================");
  console.log("      📜 SERVER LOGS CAPTURED (WITHOUT CORRELATION IDs)           ");
  console.log("==================================================================\n");

  recentLogs.forEach((line) => console.log(`   ${line}`));

  console.log("\n==================================================================");
  console.log("                      🔍 THE DIAGNOSTIC CHALLENGE                 ");
  console.log("==================================================================");
  console.log(`
  Bob comes to customer support and says:
  "I am Bob, I sent a request a few seconds ago and my image never appeared!"

  Now look at the logs above:
  1. Where is Bob's HTTP request connected to the worker error?
  2. Which of the error messages belongs to Bob, and which belongs to Dave?
  3. If there were 500 users instead of 5, how could you possibly correlate
     the HTTP request with the specific thread that crashed?

  ANSWER: You can't. The logs are completely unlinked and interleaved.
  This is why Distributed Systems mandate Correlation IDs!
==================================================================\n`);
}

runChaosTest().catch(console.error);

