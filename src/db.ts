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
): Promise<void> {
  const query = `
    UPDATE jobs
    SET status = 'failed', error_message = $1, updated_at = NOW()
    WHERE id = $2;
  `;
  await pool.query(query, [errorMessage, id]);
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

// 8. Get all jobs (newest first)
export async function getAllJobs(): Promise<JobRow[]> {
  const query = `SELECT * FROM jobs ORDER BY created_at DESC;`;
  const res = await pool.query(query);
  return res.rows;
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
