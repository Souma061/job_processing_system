import fs from "fs";
import { fileURLToPath } from "node:url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "../../data");
export const UPLOADS_DIR = path.resolve("uploads");
export const OUTPUT_DIR = path.resolve("output");
export const LOGS_DIR = path.resolve("logs");
export const LOG_FILE = path.join(LOGS_DIR, "jobs.log");

// Phase 10: Backpressure & Bounded Queue thresholds
export const MAX_QUEUE_CAPACITY = parseInt(
  process.env.MAX_QUEUE_CAPACITY || "50",
  10,
);
export const MAX_VIP_QUEUE_CAPACITY = parseInt(
  process.env.MAX_VIP_QUEUE_CAPACITY || "100",
  10,
);

// Phase 19: Security & API Key Registry
export const API_KEY_STANDARD =
  process.env.API_KEY_STANDARD || "key_std_prod_123";
export const API_KEY_VIP = process.env.API_KEY_VIP || "key_vip_prod_456";
export const API_KEY_ADMIN = process.env.API_KEY_ADMIN || "key_admin_prod_789";

export interface ApiKeyUser {
  id: string;
  role: "standard" | "vip" | "admin";
  name: string;
}

export const API_KEYS: Record<string, ApiKeyUser> = {
  [API_KEY_STANDARD]: {
    id: "user-std-101",
    role: "standard",
    name: "Standard Client",
  },
  [API_KEY_VIP]: { id: "user-vip-202", role: "vip", name: "VIP Customer" },
  [API_KEY_ADMIN]: {
    id: "user-admin-999",
    role: "admin",
    name: "System Administrator",
  },
};

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
