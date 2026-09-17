import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../data");
export const UPLOADS_DIR = path.resolve("uploads");
export const OUTPUT_DIR = path.resolve("output");
export const LOGS_DIR = path.resolve("logs");
export const LOG_FILE = path.join(LOGS_DIR, "jobs.log");

// Ensure required runtime directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Append-only structured log file helper
export function appendToLogFile(entry: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${entry}\n`, "utf-8");
  } catch (err) {
    console.error("[Logger] Failed to write to log file:", err);
  }
}

