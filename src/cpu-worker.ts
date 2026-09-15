import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";

async function run(): Promise<void> {
  const { jobId, image } = workerData;
  const startTime = Date.now();
  // console.log(`[Thread] Processing real image for ${jobId} (${image})...`);

  const inputPath = path.resolve("uploads", image);
  const outputFilename = `thumb-${jobId}.jpg`;
  const outputPath = path.resolve("output", outputFilename);

  // 1. Verify input image exists
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Source image "${image}" not found in uploads/ folder`);
  }

  // Inspect original image metadata using Sharp
  const originalStats = fs.statSync(inputPath);
  const originalMeta = await sharp(inputPath).metadata();
  console.log(
    `[Thread] Original image stats: ${JSON.stringify(originalStats)}`,
  );
  console.log(
    `[Thread] Original image metadata: ${JSON.stringify(originalMeta)}`,
  );
  const quality = 80; // Set the desired quality level (0-100)
  const outputInfo = await sharp(inputPath)
    .resize(150, 150, { fit: "cover" })
    .jpeg({ quality })
    .toFile(outputPath);

  const procesingDuration = Date.now() - startTime;
  const reductionPercentage = (1 - outputInfo.size / originalStats.size) * 100;
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };
  const imageLog = {
    original: {
      width: originalMeta.width,
      height: originalMeta.height,
      size: formatBytes(originalStats.size),
      format: originalMeta.format,
      sizedFormatted: formatBytes(originalStats.size),
    },
    thumbnail: {
      width: outputInfo.width,
      height: outputInfo.height,
      size: formatBytes(outputInfo.size),
      format: "jpeg",
      sizedFormatted: formatBytes(outputInfo.size),
      quality: quality,
      sizedBytes: outputInfo.size,
    },
  };

  console.log(`[Thread] Processing time: ${procesingDuration} ms`);
  console.log(
    `[Thread] Reduction percentage: ${reductionPercentage.toFixed(2)}%`,
  );

  console.log(
    `[Thread] Successfully generated thumbnail: output/${outputFilename}`,
  );

  // 3. Post success back to main thread
  parentPort?.postMessage({
    status: "completed",
    jobId,
    outputThumbnail: outputFilename,
    imageLog,
  });
}

run().catch((err) => {
  console.error(
    `[Thread] Failed processing ${workerData?.jobId}:`,
    err.message,
  );
  throw err;
});
