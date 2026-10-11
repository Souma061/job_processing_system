import { redisClient } from "../redis.js";
import { getSystemMetrics, type SystemMetrics } from "../metrics.js";
import { logger } from "../logger.js";

// Unique identifier for this cluster node instance
const INSTANCE_ID = process.env.PORT
  ? `node-${process.env.PORT}-${Math.random().toString(36).substring(2, 7)}`
  : `node-${process.pid}-${Math.random().toString(36).substring(2, 7)}`;

const CACHE_KEY = "metrics:system:cached";
const LOCK_KEY = "lock:metrics_refresh";
const LOCK_TTL_MS = 4500;        // 4.5s distributed lock TTL
const CACHE_TTL_SEC = 10;        // 10s Redis cache TTL
const REFRESH_INTERVAL_MS = 4000; // 4s self-scheduling spacing

// In-Memory Stale Fallback (Survives Redis expiration / network glitches)
let lastKnownGoodMetrics: SystemMetrics | null = null;
let isRefresherRunning = false;

/**
 * Computes metrics and updates both Redis and in-memory fallback.
 */
async function computeAndStoreMetrics(): Promise<SystemMetrics> {
  const fresh = await getSystemMetrics(24);
  const now = new Date().toISOString();

  const payload: SystemMetrics = {
    ...fresh,
    computedAt: now,
    dataAgeMs: 0,
    isStale: false,
  };

  // 1. Write to Redis with 10s TTL
  await redisClient.set(CACHE_KEY, JSON.stringify(payload), "EX", CACHE_TTL_SEC);

  // 2. Keep last known good copy in local memory
  lastKnownGoodMetrics = payload;

  return payload;
}

/**
 * Single cycle of the background refresher.
 * Uses Redis distributed lock (SET NX PX 4500) for multi-instance cluster coordination.
 */
async function refreshMetricsCycle(): Promise<void> {
  try {
    // Point 2: Distributed Leader Lock across cluster nodes
    const acquired = await redisClient.set(LOCK_KEY, INSTANCE_ID, "PX", LOCK_TTL_MS, "NX");

    if (acquired === "OK") {
      // Won the leader election for this cycle!
      await computeAndStoreMetrics();
      logger.debug("METRICS_REFRESH", `Instance ${INSTANCE_ID} refreshed metrics cache`);
    } else {
      // Another cluster node is leading this cycle; fetch latest into local memory
      const cached = await redisClient.get(CACHE_KEY);
      if (cached) {
        lastKnownGoodMetrics = JSON.parse(cached);
      }
    }
  } catch (err: any) {
    // Point 1: Catch error, log, but keep old value so the app never crashes
    logger.error("METRICS_REFRESH", `Background refresh failed: ${err.message}`, {
      instanceId: INSTANCE_ID,
      error: err,
    });
  } finally {
    // Point 3: Self-scheduling loop with setTimeout (guarantees NO overlapping runs)
    if (isRefresherRunning) {
      setTimeout(refreshMetricsCycle, REFRESH_INTERVAL_MS);
    }
  }
}

/**
 * Starts the self-scheduling background metrics refresher.
 */
export function startMetricsRefresher(): void {
  if (isRefresherRunning) return;
  isRefresherRunning = true;
  logger.info("METRICS_REFRESH", `Started background metrics refresher on ${INSTANCE_ID}`);
  // Schedule first background cycle
  setTimeout(refreshMetricsCycle, REFRESH_INTERVAL_MS);
}

/**
 * Point 5: Cold Start Hydration.
 * Awaited before app.listen() to guarantee the cache is warm before traffic arrives.
 */
export async function prewarmMetricsCache(): Promise<void> {
  try {
    // Check if another cluster instance already warmed the Redis cache
    const existing = await redisClient.get(CACHE_KEY);
    if (existing) {
      lastKnownGoodMetrics = JSON.parse(existing);
      logger.info("METRICS_REFRESH", "Cold start: Reused warm Redis metrics cache");
      return;
    }

    // Otherwise compute and warm immediately
    logger.info("METRICS_REFRESH", "Cold start: Computing initial system metrics cache...");
    await computeAndStoreMetrics();
    logger.info("METRICS_REFRESH", "Cold start: Metrics cache successfully pre-warmed");
  } catch (err: any) {
    logger.error("METRICS_REFRESH", `Cold start pre-warm failed: ${err.message}`);
  }
}

/**
 * Point 1 & Point 4: Client-facing cache accessor.
 * Reads exclusively from Redis or in-memory fallback.
 * NEVER falls through to an inline database query!
 */
export async function getCachedSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    // 1. Try Redis cache with a 500ms circuit breaker timeout
    const raw = (await Promise.race([
      redisClient.get(CACHE_KEY),
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error("Redis cache read timeout (500ms)")),
          500,
        ),
      ),
    ])) as string | null;

    if (raw) {
      const data: SystemMetrics = JSON.parse(raw);
      const dataAgeMs = Math.max(
        0,
        Date.now() - new Date(data.computedAt).getTime(),
      );
      const isStale = dataAgeMs > 10000; // Flag stale if older than 10s

      const result: SystemMetrics = {
        ...data,
        dataAgeMs,
        isStale,
      };

      lastKnownGoodMetrics = result;
      return result;
    }
  } catch (err: any) {
    logger.warn(
      "METRICS_CACHE",
      `Redis read failed, attempting in-memory fallback: ${err.message}`,
    );
  }

  // 2. Point 1: Stale Fallback from local memory (never query DB directly!)
  if (lastKnownGoodMetrics) {
    const dataAgeMs = Math.max(0, Date.now() - new Date(lastKnownGoodMetrics.computedAt).getTime());
    return {
      ...lastKnownGoodMetrics,
      dataAgeMs,
      isStale: true, // Marked explicitly as stale
    };
  }

  // 3. Complete Cold Start / Uninitialized failure
  return null;
}

