import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import {uploadFiletoS3  } from "./s3.js"

async function run(): Promise<void> {
  const { jobId, image } = workerData;
  const startTime = Date.now();

  const inputPath = path.resolve("uploads", image);
  const outputFilename = `thumb-${jobId}.jpg`;
  const outputPath = path.resolve("output", outputFilename);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Source image "${image}" not found in uploads/ folder`);
  }

  const originalStats = fs.statSync(inputPath);
  const originalMeta = await sharp(inputPath).metadata();
  const quality = 80;

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
    reduction: `-${reductionPercentage.toFixed(1)}%`,
    durationMs: procesingDuration,
  };

   //  UPLOAD THUMBNAIL DIRECTLY TO AWS S3
  console.log(`[Thread] Uploading thumbnail to AWS S3...`);
  const s3ThumbnailUrl = await uploadFiletoS3(
    outputPath,
    `thumbnails/${outputFilename}`,
    "image/jpeg",
  );
  console.log(`[Thread] Uploaded to S3 successfully -> ${s3ThumbnailUrl}`);

  //  DELETE LOCAL TEMPORARY FILES TO FREE UP DISK SPACE
  try {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.log(`[Thread] Cleaned up temporary local files.`);
  } catch (cleanErr) {
    console.warn(`[Thread] Warning cleaning local files:`, cleanErr);
  }

  // 4. Post back the S3 URL (which gets saved to Neon DB!)
  parentPort?.postMessage({
    status: "completed",
    jobId,
    outputThumbnail: s3ThumbnailUrl, 
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
