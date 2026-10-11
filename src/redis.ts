import { Redis } from "ioredis";
import { redisConnection } from "./queue.js";
import { logger } from "./logger.js";

/**
 * Dedicated ioredis client singleton for application caching,
 * rate limiting, and distributed locks.
 */
export const redisClient = new Redis({
  host: redisConnection.host,
  port: redisConnection.port,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisClient.on("error", (err) => {
  logger.error("REDIS", `Redis client connection error: ${err.message}`);
});

redisClient.on("connect", () => {
  logger.info("REDIS", "Connected to Redis for metrics caching and locks");
});

