import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Database record type matching our schema
export interface JobRow {
  id: string;
  type: string;
  status: string;
  image: string;
  original_name: string | null;
  thumbnail: string | null;
  worker_id: string | null;
  metrics: any | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

// 1. Initialize table and indexes in Neon PostgreSQL
export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("[Postgres] Connected to Neon DB. Initializing schema...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id VARCHAR(64) PRIMARY KEY,
        type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL,
        image VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        thumbnail VARCHAR(255),
        worker_id VARCHAR(64),
        metrics JSONB,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    `);
    console.log("[Postgres] Schema verified and ready.");
  } finally {
    client.release();
  }
}

// 2. Insert new job
// 2. Insert or Upsert job (idempotent: safe for retries)
export async function insertJob(
  id: string,
  type: string,
  status: string,
  image: string,
  originalName?: string,
): Promise<JobRow> {
  const query = `
    INSERT INTO jobs (id, type, status, image, original_name, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE
    SET updated_at = NOW()
    RETURNING *;
  `;
  const res = await pool.query(query, [
    id,
    type,
    status,
    image,
    originalName || image,
  ]);
  return res.rows[0];
}

// 3. Mark job as in-progress (claimed by worker)
export async function markJobInProgress(
  id: string,
  workerId: string,
): Promise<void> {
  const query = `
    UPDATE jobs
    SET status = 'in-progress', worker_id = $1, updated_at = NOW()
    WHERE id = $2;
  `;
  await pool.query(query, [workerId, id]);
}

// 4. Mark job as completed with thumbnail and metrics
export async function markJobCompleted(
  id: string,
  thumbnail: string,
  metrics: any,
): Promise<void> {
  const query = `
    UPDATE jobs
    SET status = 'completed', thumbnail = $1, metrics = $2, updated_at = NOW()
    WHERE id = $3;
  `;
  await pool.query(query, [thumbnail, JSON.stringify(metrics), id]);
}

// 5. Mark job as failed
export async function markJobFailed(
  id: string,
  errorMessage: string,
  metrics: any = null,
): Promise<void> {
  const query = `
    UPDATE jobs
    SET status = 'failed', error_message = $1, metrics = COALESCE($2, metrics), updated_at = NOW()
    WHERE id = $3;
  `;
  await pool.query(query, [
    errorMessage,
    metrics ? JSON.stringify(metrics) : null,
    id,
  ]);
}

// 6. Check for in-flight duplicates (pending or in-progress)
export async function findInFlightJobByImage(
  image: string,
): Promise<JobRow | null> {
  const query = `
    SELECT * FROM jobs
    WHERE (image = $1 OR original_name = $1)
      AND status IN ('pending', 'in-progress')
    LIMIT 1;
  `;
  const res = await pool.query(query, [image]);
  return res.rows[0] || null;
}

// 7. Get job by ID
export async function getJobById(id: string): Promise<JobRow | null> {
  const query = `SELECT * FROM jobs WHERE id = $1;`;
  const res = await pool.query(query, [id]);
  return res.rows[0] || null;
}

// 8. Get all jobs (newest first, defaulted to 50 for high-load performance)
export async function getAllJobs(limit: number = 50): Promise<JobRow[]> {
  const query = `SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1;`;
  const res = await pool.query(query, [limit]);
  return res.rows;
}

// 8b. High-performance scalar count for health checks
export async function getTotalJobsCount(): Promise<number> {
  const res = await pool.query("SELECT COUNT(*) AS total FROM jobs;");
  return parseInt(res.rows[0]?.total || "0", 10);
}

export interface DbAggregatedMetrics {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  inProgressCount: number;
  pendingCount: number;
  completedLast60s: number;
  totalTurnaround: {
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  };
  queueWait: {
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  };
  processingDuration: {
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  };
  priorityBreakdown: {
    vip: { count: number; avgWaitMs: number; p50WaitMs: number };
    normal: { count: number; avgWaitMs: number; p50WaitMs: number };
    waitAdvantageMs: number;
  };
}

// 8c. High-performance SQL aggregation for metrics & percentiles (PostgreSQL percentile_cont)
export async function getAggregatedSystemMetricsFromDb(
  windowHours?: number,
): Promise<DbAggregatedMetrics> {
  const query = `
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      COUNT(*) FILTER (WHERE status = 'in-progress')::int AS in_progress_count,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= NOW() - INTERVAL '60 seconds')::int AS completed_last_60s,

      -- Timings
      COUNT(*) FILTER (WHERE metrics IS NOT NULL AND metrics->'timings' IS NOT NULL)::int AS timings_count,
      COALESCE(ROUND(AVG((metrics->'timings'->>'totalLatencyMs')::numeric)), 0)::int AS total_avg,
      COALESCE(MIN((metrics->'timings'->>'totalLatencyMs')::numeric), 0)::int AS total_min,
      COALESCE(MAX((metrics->'timings'->>'totalLatencyMs')::numeric), 0)::int AS total_max,
      COALESCE(ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY (metrics->'timings'->>'totalLatencyMs')::numeric))::int, 0) AS total_p50,
      COALESCE(ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->'timings'->>'totalLatencyMs')::numeric))::int, 0) AS total_p95,
      COALESCE(ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY (metrics->'timings'->>'totalLatencyMs')::numeric))::int, 0) AS total_p99,

      COALESCE(ROUND(AVG((metrics->'timings'->>'queueWaitMs')::numeric)), 0)::int AS wait_avg,
      COALESCE(MIN((metrics->'timings'->>'queueWaitMs')::numeric), 0)::int AS wait_min,
      COALESCE(MAX((metrics->'timings'->>'queueWaitMs')::numeric), 0)::int AS wait_max,
      COALESCE(ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY (metrics->'timings'->>'queueWaitMs')::numeric))::int, 0) AS wait_p50,
      COALESCE(ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->'timings'->>'queueWaitMs')::numeric))::int, 0) AS wait_p95,
      COALESCE(ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY (metrics->'timings'->>'queueWaitMs')::numeric))::int, 0) AS wait_p99,

      COALESCE(ROUND(AVG((metrics->'timings'->>'processingDurationMs')::numeric)), 0)::int AS proc_avg,
      COALESCE(MIN((metrics->'timings'->>'processingDurationMs')::numeric), 0)::int AS proc_min,
      COALESCE(MAX((metrics->'timings'->>'processingDurationMs')::numeric), 0)::int AS proc_max,
      COALESCE(ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY (metrics->'timings'->>'processingDurationMs')::numeric))::int, 0) AS proc_p50,
      COALESCE(ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->'timings'->>'processingDurationMs')::numeric))::int, 0) AS proc_p95,
      COALESCE(ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY (metrics->'timings'->>'processingDurationMs')::numeric))::int, 0) AS proc_p99,

      -- Priority Breakdown
      COUNT(*) FILTER (WHERE (metrics->>'priority')::int = 1)::int AS vip_count,
      COALESCE(ROUND(AVG((metrics->'timings'->>'queueWaitMs')::numeric) FILTER (WHERE (metrics->>'priority')::int = 1)), 0)::int AS vip_avg_wait,
      COALESCE(ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY (metrics->'timings'->>'queueWaitMs')::numeric) FILTER (WHERE (metrics->>'priority')::int = 1))::int, 0) AS vip_p50_wait,

      COUNT(*) FILTER (WHERE metrics IS NOT NULL AND metrics->'timings' IS NOT NULL AND (metrics->>'priority')::int != 1)::int AS norm_count,
      COALESCE(ROUND(AVG((metrics->'timings'->>'queueWaitMs')::numeric) FILTER (WHERE metrics IS NOT NULL AND metrics->'timings' IS NOT NULL AND (metrics->>'priority')::int != 1)), 0)::int AS norm_avg_wait,
      COALESCE(ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY (metrics->'timings'->>'queueWaitMs')::numeric) FILTER (WHERE metrics IS NOT NULL AND metrics->'timings' IS NOT NULL AND (metrics->>'priority')::int != 1))::int, 0) AS norm_p50_wait

    FROM jobs
    WHERE ($1::int IS NULL OR created_at >= NOW() - ($1::int || ' hours')::interval);
  `;

  const param = windowHours && windowHours > 0 ? windowHours : null;
  const res = await pool.query(query, [param]);
  const row = res.rows[0];

  const timingsCount = row.timings_count || 0;
  const vipCount = row.vip_count || 0;
  const normCount = row.norm_count || 0;
  const waitAdvantageMs = Math.max(0, row.norm_avg_wait - row.vip_avg_wait);

  return {
    totalCount: row.total_count || 0,
    completedCount: row.completed_count || 0,
    failedCount: row.failed_count || 0,
    inProgressCount: row.in_progress_count || 0,
    pendingCount: row.pending_count || 0,
    completedLast60s: row.completed_last_60s || 0,
    totalTurnaround: {
      count: timingsCount,
      avg: row.total_avg,
      min: row.total_min,
      max: row.total_max,
      p50: row.total_p50,
      p95: row.total_p95,
      p99: row.total_p99,
    },
    queueWait: {
      count: timingsCount,
      avg: row.wait_avg,
      min: row.wait_min,
      max: row.wait_max,
      p50: row.wait_p50,
      p95: row.wait_p95,
      p99: row.wait_p99,
    },
    processingDuration: {
      count: timingsCount,
      avg: row.proc_avg,
      min: row.proc_min,
      max: row.proc_max,
      p50: row.proc_p50,
      p95: row.proc_p95,
      p99: row.proc_p99,
    },
    priorityBreakdown: {
      vip: {
        count: vipCount,
        avgWaitMs: row.vip_avg_wait,
        p50WaitMs: row.vip_p50_wait,
      },
      normal: {
        count: normCount,
        avgWaitMs: row.norm_avg_wait,
        p50WaitMs: row.norm_p50_wait,
      },
      waitAdvantageMs,
    },
  };
}

// 9. Startup Crash Recovery: Reset in-progress to pending, return all pending jobs
export async function recoverJobsFromDatabase(): Promise<JobRow[]> {
  const client = await pool.connect();
  try {
    // Reset any interrupted jobs
    const resetRes = await client.query(`
      UPDATE jobs
      SET status = 'pending', updated_at = NOW()
      WHERE status = 'in-progress'
      RETURNING id;
    `);

    if (resetRes.rows.length > 0) {
      console.log(
        `[Postgres] Reset ${resetRes.rows.length} interrupted in-progress jobs back to 'pending'.`,
      );
    }

    // Fetch all pending jobs to re-queue
    const pendingRes = await client.query(`
      SELECT * FROM jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC;
    `);

    return pendingRes.rows;
  } finally {
    client.release();
  }
}

// 10. Delete specific jobs by their IDs and return their thumbnail keys for cleanup
export async function deleteJobsByIds(ids: string[]): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const query = `
    DELETE FROM jobs
    WHERE id = ANY($1::text[])
    RETURNING thumbnail;
  `;
  const res = await pool.query(query, [ids]);
  return res.rows.map((r) => r.thumbnail).filter(Boolean);
}

// 11. Delete all completed and failed jobs, returning thumbnail keys
export async function deleteAllFinishedJobs(): Promise<string[]> {
  const query = `
    DELETE FROM jobs
    WHERE status IN ('completed', 'failed')
    RETURNING thumbnail;
  `;
  const res = await pool.query(query);
  return res.rows.map((r) => r.thumbnail).filter(Boolean);
}
