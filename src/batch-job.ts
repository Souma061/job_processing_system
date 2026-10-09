import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const UPLOADS_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const SERVER_URL = "http://localhost:3000";

interface ColorDef {
  name: string;
  r: number;
  g: number;
  b: number;
  priority: number;
}

const BATCH_COLORS: ColorDef[] = [
  { name: "sunset-orange", r: 255, g: 111, b: 0, priority: 1 }, // VIP
  { name: "ocean-blue", r: 33, g: 150, b: 243, priority: 5 },   // Normal
  { name: "emerald-green", r: 46, g: 125, b: 50, priority: 5 }, // Normal
  { name: "royal-purple", r: 106, g: 27, b: 154, priority: 1 }, // VIP
  { name: "coral-pink", r: 233, g: 30, b: 99, priority: 5 },    // Normal
  { name: "golden-amber", r: 255, g: 193, b: 7, priority: 5 },  // Normal
];

async function createColorImage(name: string, r: number, g: number, b: number): Promise<string> {
  const filename = `batch-${name}-${Date.now()}.jpg`;
  const filePath = path.join(UPLOADS_DIR, filename);

  // Generate a 1200x800 image with sharp
  await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r, g, b },
    },
  })
    .jpeg({ quality: 90 })
    .toFile(filePath);

  return filename;
}

async function runBatch() {
  console.log("\n🎨 ===================================================");
  console.log("   🚀 Launching Batch Image Processing Job (6 images)   ");
  console.log("===================================================\n");

  const jobSubmissions: { name: string; filename: string; priority: number; jobId?: string }[] = [];

  // 1. Generate all test images
  console.log("📸 Step 1: Generating 6 unique images in uploads/...");
  for (const item of BATCH_COLORS) {
    const filename = await createColorImage(item.name, item.r, item.g, item.b);
    jobSubmissions.push({
      name: item.name,
      filename,
      priority: item.priority,
    });
    console.log(`   ✓ Created: ${filename} (${item.name}, Priority: ${item.priority === 1 ? "⭐ VIP" : "Normal"})`);
  }

  // 2. Submit all jobs to Express API
  console.log("\n📨 Step 2: Enqueueing batch to POST /jobs...");
  for (const job of jobSubmissions) {
    const res = await fetch(`${SERVER_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: job.filename,
        priority: job.priority,
        type: "thumbnail",
      }),
    });

    if (!res.ok) {
      console.error(`   ❌ Failed to enqueue ${job.filename}: ${res.status} ${res.statusText}`);
      continue;
    }

    const data = (await res.json()) as { id: string; status: string };
    job.jobId = data.id;
    console.log(`   ✓ Enqueued: [${data.id}] (${job.name}) -> ${data.status}`);
  }

  // 3. Poll until all batch jobs complete
  console.log("\n⏳ Step 3: Waiting for workers to process thumbnails & upload to AWS S3...");
  const pendingIds = new Set(jobSubmissions.map((j) => j.jobId).filter(Boolean));
  const startTime = Date.now();

  while (pendingIds.size > 0 && Date.now() - startTime < 30000) {
    await new Promise((r) => setTimeout(r, 1000));

    for (const id of Array.from(pendingIds)) {
      const res = await fetch(`${SERVER_URL}/jobs/${id}`);
      if (res.ok) {
        const jobData = (await res.json()) as any;
        if (jobData.status === "completed" || jobData.status === "failed") {
          pendingIds.delete(id);
          const icon = jobData.status === "completed" ? "✅" : "❌";
          console.log(`   ${icon} Finished ${jobData.id} -> ${jobData.status} by ${jobData.worker_id || "worker"}`);
        }
      }
    }
  }

  // 4. Print Summary
  console.log("\n🎉 ===================================================");
  console.log("           Batch Job Execution Summary                ");
  console.log("===================================================\n");

  const allJobsRes = await fetch(`${SERVER_URL}/jobs`);
  if (allJobsRes.ok) {
    const jobs = (await allJobsRes.json()) as any[];
    for (const item of jobSubmissions) {
      const found = jobs.find((j) => j.id === item.jobId);
      const s3Url = found?.payload?.thumbnail;
      const s3Key = s3Url ? s3Url.split("?")[0].split(".amazonaws.com/")[1] : "N/A";
      console.log(`• [${item.priority === 1 ? "⭐ VIP" : "NORMAL"}] ${item.name}`);
      console.log(`   Job ID: ${item.jobId}`);
      console.log(`   Status: ${found?.status}`);
      console.log(`   S3 Key: ${s3Key}\n`);
    }
  }
}

runBatch().catch(console.error);

