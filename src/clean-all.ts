import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pool } from "./db.js";
import { imageQueue } from "./queue.js";
import { s3Client } from "./s3.js";

dotenv.config();

const bucketName = process.env.AWS_S3_BUCKET_NAME;

async function clearAll() {
  console.log(
    "\n🧹 Starting complete cleanup across Neon DB, AWS S3, and local disks...\n",
    "\n🧹 Starting complete cleanup across Redis, Neon DB, AWS S3, and local disks...\n",
  );

  // 1. Clear Neon DB
  // 1. Clear BullMQ Redis Queue
  try {
    console.log("⏳ [Redis] Draining and obliterating BullMQ queue...");
    await imageQueue.drain();
    await imageQueue.obliterate({ force: true });
    console.log("✅ [Redis] BullMQ image-processing-queue completely purged!");
  } catch (err: any) {
    console.error("❌ [Redis] Error cleaning BullMQ queue:", err.message);
  }

  // 2. Clear Neon DB
  try {
    const res = await pool.query("DELETE FROM jobs RETURNING id;");
    console.log(
      `✅ [Neon DB] Deleted ${res.rowCount} job records from the database.`,
    );
  } catch (err: any) {
    console.error("❌ [Neon DB] Error clearing jobs table:", err.message);
  }

  // 2. Clear AWS S3 Bucket
  if (bucketName) {
    try {
      console.log(
        `⏳ [AWS S3] Scanning bucket "${bucketName}" for thumbnails...`,
      );
      let continuationToken: string | undefined = undefined;
      let totalDeletedS3 = 0;

      do {
        const listCmd = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: "thumbnails/",
          ContinuationToken: continuationToken,
        });

        const listRes = await s3Client.send(listCmd);
        const objects =
          listRes.Contents?.map((obj) => ({ Key: obj.Key })) || [];

        if (objects.length > 0) {
          const deleteCmd = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects as any },
          });
          await s3Client.send(deleteCmd);
          totalDeletedS3 += objects.length;
        }

        continuationToken = listRes.NextContinuationToken;
      } while (continuationToken);

      console.log(
        `✅ [AWS S3] Deleted ${totalDeletedS3} thumbnail objects from S3 bucket.`,
      );
    } catch (err: any) {
      console.error("❌ [AWS S3] Error cleaning S3 objects:", err.message);
    }
  } else {
    console.warn("⚠️ [AWS S3] No bucket name found in .env");
  }

  // 3. Clear local uploads/ and output/ directories
  try {
    const uploadsDir = path.resolve("uploads");
    const outputDir = path.resolve("output");

    if (fs.existsSync(uploadsDir)) {
      const uploadFiles = fs.readdirSync(uploadsDir);
      for (const f of uploadFiles) {
        fs.unlinkSync(path.join(uploadsDir, f));
      }
      console.log(
        `✅ [Local] Cleared ${uploadFiles.length} files from uploads/`,
      );
    }

    if (fs.existsSync(outputDir)) {
      const outputFiles = fs.readdirSync(outputDir);
      for (const f of outputFiles) {
        fs.unlinkSync(path.join(outputDir, f));
      }
      console.log(
        `✅ [Local] Cleared ${outputFiles.length} files from output/`,
      );
    }
  } catch (err: any) {
    console.error("❌ [Local] Error cleaning directories:", err.message);
  }

  console.log("\n✨ All systems completely clean and fresh!\n");
  await pool.end();
  process.exit(0);
}

clearAll();
