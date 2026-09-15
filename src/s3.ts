import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const region = process.env.AWS_REGION || "ap-south-1";
const bucketName = process.env.AWS_S3_BUCKET_NAME;

export const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Upload private file to S3
export async function uploadFiletoS3(
  localFilePath: string,
  s3Key: string,
  contentType: string = "image/jpeg",
): Promise<string> {
  if (!bucketName) {
    throw new Error("S3 bucket name is not defined in environment variables.");
  }
  const fileStream = fs.createReadStream(localFilePath);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: fileStream,
    ContentType: contentType,
  });
  await s3Client.send(command);

  // Return the S3 key (e.g. "thumbnails/thumb-xxx.jpg")
  return s3Key;
}

// Generate a temporary presigned download URL (valid for expiresInSeconds, default 1 hour)
export async function getPresignedDownloadUrl(
  s3Key: string,
  expiresInSeconds: number = 3600,
): Promise<string> {
  if (!bucketName) {
    throw new Error("S3 bucket name is not defined in environment variables.");
  }
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
  });
  return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

// Delete an object from S3
export async function deleteFileFromS3(s3Key: string): Promise<void> {
  if (!bucketName || !s3Key) return;
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });
    await s3Client.send(command);
  } catch (err) {
    console.warn(`[S3] Failed to delete object ${s3Key}:`, err);
  }
}
