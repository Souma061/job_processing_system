import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "../config/constants.js";

/**
 * Validates that an image filename cannot break out of the uploads/ directory
 * Defends against Path Traversal vulnerabilities (e.g., ../../etc/passwd or ..\..\boot.ini)
 */
export function validatePathSafety(filename: string): {
  valid: boolean;
  reason?: string;
  safeName?: string;
} {
  if (!filename || typeof filename !== "string") {
    return { valid: false, reason: "Filename must be a non-empty string." };
  }

  // 1. Detect Null Byte Injection (%00 / \0)
  if (filename.includes("\0")) {
    return { valid: false, reason: "Null byte injection detected." };
  }

  // 2. Detect directory traversal patterns
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return {
      valid: false,
      reason: "Path traversal characters ('..', '/', '\\') are strictly forbidden.",
    };
  }

  // 3. Resolve path and ensure it strictly resides within UPLOADS_DIR
  const resolvedPath = path.resolve(UPLOADS_DIR, filename);
  const normalizedUploads = path.resolve(UPLOADS_DIR) + path.sep;

  // Path must start with UPLOADS_DIR directory prefix
  if (!resolvedPath.startsWith(normalizedUploads) && resolvedPath !== path.resolve(UPLOADS_DIR, filename)) {
    return { valid: false, reason: "Resolved path escapes uploads directory." };
  }

  const safeName = path.basename(filename);
  return { valid: true, safeName };
}

/**
 * Inspects binary file header magic bytes to verify genuine image formats.
 * Defends against disguised scripts/malware named with .jpg or .png extensions.
 */
export function validateImageMagicBytes(filePath: string): {
  valid: boolean;
  format?: string;
  error?: string;
} {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: `File "${filePath}" does not exist.` };
  }

  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(16);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);

    if (bytesRead < 4) {
      return {
        valid: false,
        error: "File is too small to contain valid image magic bytes.",
      };
    }

    // 1. JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { valid: true, format: "jpeg" };
    }

    // 2. PNG: 89 50 4E 47 (\x89PNG)
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return { valid: true, format: "png" };
    }

    // 3. GIF: 47 49 46 38 (GIF8)
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return { valid: true, format: "gif" };
    }

    // 4. WEBP: RIFF (bytes 0-3) + WEBP (bytes 8-11)
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { valid: true, format: "webp" };
    }

    return {
      valid: false,
      error:
        "File failed magic byte signature check. Expected JPEG (FF D8 FF), PNG (89 50 4E 47), GIF, or WEBP.",
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to inspect magic bytes: ${err.message}`,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

