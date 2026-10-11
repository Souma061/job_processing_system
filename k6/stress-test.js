import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// Custom Stress Metrics
const jobCreationDuration = new Trend("stress_job_creation_duration_ms");
const jobsEnqueued = new Counter("stress_jobs_enqueued_count");
const jobsBackpressured = new Counter("stress_jobs_backpressured_count");
const readOperationsPassed = new Counter("stress_read_ops_passed_count");
const unexpectedErrorRate = new Rate("stress_unexpected_error_rate");

export const options = {
  scenarios: {
    significant_stress_test: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 25 }, // Stage 1: Warmup ramp to 25 VUs
        { duration: "30s", target: 60 }, // Stage 2: Heavy load ramp to 60 VUs
        { duration: "30s", target: 100 }, // Stage 3: Stress surge to 100 VUs
        { duration: "40s", target: 100 }, // Stage 4: Sustained maximum stress at 100 VUs
        { duration: "30s", target: 0 }, // Stage 5: Recovery and graceful cooldown
      ],
      gracefulRampDown: "10s",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    // Under 100 VU extreme stress test, 95% of requests respond in under 5.0 seconds
    'http_req_duration': ['p(95)<5000'],
    // System must not crash or return unhandled 500 errors (<= 1% strict error threshold)
    'stress_unexpected_error_rate': ['rate<=0.01'],
    // Strict assertion pass rate >= 99%
    'checks': ['rate>=0.99'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3000';

export default function () {
  const rand = Math.random();
  const correlationId = `k6-stress-vu-${__VU}-iter-${__ITER}-${Date.now()}`;

  if (rand < 0.70) {
    // 70% Traffic: Job Ingestion (Standard vs VIP Priority)
    const isVip = Math.random() < 0.30; // 30% VIP priority (limit 100), 70% Normal (limit 50)
    const priority = isVip ? 1 : 5;

    const payload = JSON.stringify({
      image: 'sample.jpg',
      priority,
      type: 'thumbnail',
    });

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    jobCreationDuration.add(res.timings.duration);

    if (res.status === 201) {
      jobsEnqueued.add(1);
      const ok = check(res, {
        'Job accepted (201)': (r) => r.status === 201,
        'Correlation ID propagated': (r) => {
          const hdr = r.headers['X-Correlation-Id'] || r.headers['x-correlation-id'];
          return hdr === correlationId;
        },
      });
      unexpectedErrorRate.add(!ok);
    } else if (res.status === 503) {
      jobsBackpressured.add(1);
      const retryHeader = res.headers['Retry-After'] || res.headers['retry-after'];
      const ok = check(res, {
        'Backpressure load-shed (503)': (r) => r.status === 503,
        'Has Retry-After header': () => retryHeader !== undefined,
        'Backpressure code returned': (r) => r.json('error') === 'BACKPRESSURE_LIMIT_REACHED',
      });
      unexpectedErrorRate.add(!ok);
    } else {
      // Any status other than 201 or 503 is unexpected (e.g., 500 internal server error)
      check(res, { "Unexpected status code": () => false });
      unexpectedErrorRate.add(true);
    }
  } else if (rand < 0.85) {
    // 15% Traffic: Observability & Health Polling under load
    const endpoint = Math.random() < 0.5 ? "/health" : "/metrics";
    const res = http.get(`${BASE_URL}${endpoint}`);

    const ok = check(res, {
      "Observability endpoint returns 200": (r) => r.status === 200,
    });
    if (ok) readOperationsPassed.add(1);
    unexpectedErrorRate.add(!ok);
  } else {
    // 15% Traffic: Concurrent Job Queries
    const res = http.get(`${BASE_URL}/jobs?limit=20`);

    const ok = check(res, {
      "Jobs list returned 200": (r) => r.status === 200,
      "Jobs returned as array": (r) => Array.isArray(r.json()),
    });
    if (ok) readOperationsPassed.add(1);
    unexpectedErrorRate.add(!ok);
  }

  // Realistic stress think time (50ms - 150ms) to generate sustained high RPS
  sleep(0.05 + Math.random() * 0.1);
}
