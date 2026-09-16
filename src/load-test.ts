import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const UPLOADS_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configurable load parameters
const CONCURRENT_USERS = 1000; // 100-150 users
const SERVER_URL = "http://localhost:3000";

async function generateDummyImage(
  filename: string,
  width: number,
  height: number,
): Promise<string> {
  const filePath = path.join(UPLOADS_DIR, filename);
  // Generate a random colored SVG image and save as JPEG to uploads/
  const r = Math.floor(Math.random() * 255);
  const g = Math.floor(Math.random() * 255);
  const b = Math.floor(Math.random() * 255);

  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r, g, b },
    },
  })
    .jpeg({ quality: 80 })
    .toFile(filePath);

  return filePath;
}

async function simulateUser(userId: number): Promise<{
  userId: number;
  durationMs: number;
  status: number;
  jobId?: string;
  error?: string;
}> {
  const startTime = Date.now();
  const imageName = `load-test-user-${userId}-${Date.now()}.jpg`;

  try {
    // 1. Generate image file on disk in uploads/
    await generateDummyImage(imageName, 800, 600);

    // 2. Submit job to Express API
    const response = await fetch(`${SERVER_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imageName,
        type: "thumbnail",
      }),
    });

    const data: any = await response.json();
    const durationMs = Date.now() - startTime;

    return {
      userId,
      durationMs,
      status: response.status,
      jobId: data.id,
    };
  } catch (err: any) {
    return {
      userId,
      durationMs: Date.now() - startTime,
      status: 500,
      error: err.message,
    };
  }
}

async function runLoadTest() {
  console.log(
    `\n🚀 Starting Load Test with ${CONCURRENT_USERS} simulated concurrent users...\n`,
  );
  const overallStart = Date.now();

  // Fire all requests concurrently!
  const userPromises = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
    simulateUser(i + 1),
  );
  const results = await Promise.all(userPromises);

  const totalTimeSec = ((Date.now() - overallStart) / 1000).toFixed(2);
  const successful = results.filter(
    (r) => r.status === 201 || r.status === 200,
  );
  const failed = results.filter((r) => r.status >= 400);

  const avgEnqueueLatency = (
    results.reduce((acc, r) => acc + r.durationMs, 0) / results.length
  ).toFixed(1);

  console.log(`\n================== LOAD TEST RESULTS ==================`);
  console.log(`Simulated Users:           ${CONCURRENT_USERS}`);
  console.log(`Successfully Enqueued:     ${successful.length}`);
  console.log(`Failed Submissions:        ${failed.length}`);
  console.log(`Avg API Response Latency:  ${avgEnqueueLatency} ms`);
  console.log(`Total Batch Dispatch Time: ${totalTimeSec} seconds`);
  console.log(`=======================================================\n`);
  console.log(`👀 Check your Dashboard at http://localhost:3000 to watch:`);
  console.log(`   1. Queue Depth spike up to ~${successful.length}`);
  console.log(`   2. Worker-1 draining the queue one by one!`);
  console.log(`   3. Total time taken for Worker-1 to reach 0 queue depth.\n`);
}

runLoadTest();
