/**
 * Twelve Dollar Server Challenge - Job Processing Edition
 * Inspired by: https://github.com/arjaythedev/twelve-dollar-server-challenge
 *
 * One virtual user (VU) = one real person actively using the job processing dashboard.
 * A score is the highest number of VUs your EC2 instance ($12/mo t3.small, 2 vCPU, 2 GB)
 * can sustain while maintaining:
 *   - p95 latency < 500 ms
 *   - p99 tail latency < 1000 ms
 *   - under 1% unexpected error rate
 *
 * Real User Behavior Loop:
 *   1. Check /health & /metrics -> think 2-5s
 *   2. Browse /jobs?limit=10 -> think 3-6s
 *   3. Inspect a specific job /jobs/:id (30% chance) -> think 2-4s
 *   4. Submit a new image job /jobs (20% chance: 80% Normal, 20% VIP)
 *   5. Idle 4-10s -> repeat
 *
 * Run Examples:
 *   k6 run -e VUS=100 k6/twelve-dollar-load.js
 *   k6 run -e VUS=500 -e DURATION=3m k6/twelve-dollar-load.js
 *   k6 run -e VUS=1000 -e BASE_URL=http://3.7.248.11:3000 k6/twelve-dollar-load.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

// Configurable Environment Variables
const BASE_URL = __ENV.BASE_URL || 'http://3.7.248.11:3000';
const VUS = Number(__ENV.VUS || 100);
const DURATION = __ENV.DURATION || '2m';
const RAMP_UP = __ENV.RAMP_UP || '30s';

const KEY_STD = __ENV.API_KEY_STANDARD || 'key_std_prod_123';
const KEY_VIP = __ENV.API_KEY_VIP || 'key_vip_prod_456';

// Probabilities mimicking real browsing sessions
const JOB_SUBMISSION_PROB = 0.20; // 20% chance user submits an image per loop
const JOB_INSPECT_PROB = 0.30;    // 30% chance user opens a specific job detail

// Custom Challenge Metrics
const jobsEnqueued = new Counter('challenge_jobs_enqueued');
const jobsBackpressured = new Counter('challenge_jobs_backpressured_503');
const readOperationsPassed = new Counter('challenge_read_ops_passed');
const unexpectedFailures = new Rate('challenge_unexpected_failures');

export const options = {
  scenarios: {
    challenge_users: {
      executor: 'ramping-vus',
      stages: [
        { duration: RAMP_UP, target: VUS },   // Ramp up to target VUs
        { duration: DURATION, target: VUS },  // Hold sustained load
        { duration: '20s', target: 0 },       // Ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Challenge Rules: strict sub-second SLAs
    'http_req_duration': ['p(95)<500', 'p(99)<1000'],
    // System must not crash: unhandled 500 errors < 1%
    'challenge_unexpected_failures': ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const between = (lo, hi) => lo + Math.random() * (hi - lo);

export default function () {
  // Spread out VUs that start in the same tick
  if (__ITER === 0) sleep(between(0, 5));

  const isVip = Math.random() < 0.20; // 20% VIP users, 80% Standard users
  const apiKey = isVip ? KEY_VIP : KEY_STD;
  const authHeaders = {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  };

  // --------------------------------------------------------------------------
  // Step 1: Open Dashboard (GET /health & GET /metrics)
  // --------------------------------------------------------------------------
  const healthRes = http.get(`${BASE_URL}/health`, { tags: { name: 'GET /health' } });
  const healthOk = check(healthRes, { 'health 200': (r) => r.status === 200 });
  if (healthOk) readOperationsPassed.add(1);
  unexpectedFailures.add(!healthOk);

  const metricsRes = http.get(`${BASE_URL}/metrics`, {
    headers: authHeaders,
    tags: { name: 'GET /metrics' },
  });
  const metricsOk = check(metricsRes, { 'metrics 200': (r) => r.status === 200 });
  if (metricsOk) readOperationsPassed.add(1);
  unexpectedFailures.add(!metricsOk);

  // Think time: reading dashboard stats (2 - 5s)
  sleep(between(2, 5));

  // --------------------------------------------------------------------------
  // Step 2: Browse Recent Jobs Feed (GET /jobs?limit=10)
  // --------------------------------------------------------------------------
  const feedRes = http.get(`${BASE_URL}/jobs?limit=10`, {
    headers: authHeaders,
    tags: { name: 'GET /jobs' },
  });
  const feedOk = check(feedRes, { 'feed 200': (r) => r.status === 200 });
  if (feedOk) readOperationsPassed.add(1);
  unexpectedFailures.add(!feedOk);

  let pickedJobId = null;
  if (feedOk) {
    try {
      const jobs = feedRes.json();
      if (Array.isArray(jobs) && jobs.length > 0) {
        pickedJobId = jobs[Math.floor(Math.random() * jobs.length)].id;
      }
    } catch {
      // JSON parse fallback
    }
  }

  // Think time: scanning the job feed (3 - 6s)
  sleep(between(3, 6));

  // --------------------------------------------------------------------------
  // Step 3: Inspect a Specific Job (30% probability)
  // --------------------------------------------------------------------------
  if (pickedJobId && Math.random() < JOB_INSPECT_PROB) {
    const jobRes = http.get(`${BASE_URL}/jobs/${pickedJobId}`, {
      headers: authHeaders,
      tags: { name: 'GET /jobs/:id' },
    });
    const jobOk = check(jobRes, { 'job_detail 200': (r) => r.status === 200 });
    if (jobOk) readOperationsPassed.add(1);
    unexpectedFailures.add(!jobOk);

    // Think time: viewing thumbnail (2 - 4s)
    sleep(between(2, 4));
  }

  // --------------------------------------------------------------------------
  // Step 4: Submit a New Job (20% probability)
  // --------------------------------------------------------------------------
  if (Math.random() < JOB_SUBMISSION_PROB) {
    const correlationId = `challenge-vu-${__VU}-iter-${__ITER}-${Date.now()}`;
    const payload = JSON.stringify({
      image: 'sample.jpg',
      type: 'thumbnail',
      priority: isVip ? 1 : 5,
    });

    const postRes = http.post(`${BASE_URL}/jobs`, payload, {
      headers: {
        ...authHeaders,
        'X-Correlation-Id': correlationId,
      },
      tags: { name: 'POST /jobs' },
    });

    if (postRes.status === 201) {
      // Accepted and enqueued!
      jobsEnqueued.add(1);
      const ok = check(postRes, { 'job_created 201': (r) => r.status === 201 });
      unexpectedFailures.add(!ok);
    } else if (postRes.status === 503) {
      // Queue reached bounded capacity (50 normal or 100 VIP) -> graceful backpressure
      jobsBackpressured.add(1);
      const hasRetry = postRes.headers['Retry-After'] !== undefined || postRes.headers['retry-after'] !== undefined;
      const ok = check(postRes, {
        'backpressure 503': (r) => r.status === 503,
        'has retry-after': () => hasRetry,
      });
      unexpectedFailures.add(!ok);
    } else {
      // Unhandled 500 or crash
      check(postRes, { 'unexpected status': () => false });
      unexpectedFailures.add(true);
    }
  }

  // Idle before next user session (4 - 10s)
  sleep(between(4, 10));
}
