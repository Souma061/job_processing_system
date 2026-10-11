import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom K6 Metrics
const jobCreationDuration = new Trend('job_creation_duration_ms');
const edgeCasesPassed = new Counter('edge_cases_passed_count');
const errorRate = new Rate('system_error_rate');

// Test Configuration
export const options = {
  scenarios: {
    // Stage 1: Exhaustive Edge Cases & Integration Checks (Sequential)
    edge_cases_and_functional: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '25s',
      exec: 'testEdgeCasesAndFunctional',
    },
    // Stage 2: Concurrent Multi-User Load Test (10 Virtual Users)
    concurrent_virtual_users: {
      executor: 'ramping-vus',
      startTime: '5s', // Starts right after initial functional checks
      stages: [
        { duration: '5s', target: 5 },   // Ramp up to 5 VUs
        { duration: '10s', target: 10 }, // Burst to 10 VUs
        { duration: '5s', target: 0 },   // Ramp down to 0
      ],
      exec: 'testConcurrentVirtualUsers',
    },
  },
  thresholds: {
    // SLA Guarantees
    'http_req_duration': ['p(95)<1000'], // 95% of API requests should respond in under 1000ms
    'system_error_rate': ['rate<=0.01'],  // Total unexpected error rate <= 1% strict
    'checks': ['rate>=0.99'],             // Strict 99%+ assertions must pass
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3000';
const KEY_STD = 'key_std_prod_123';
const KEY_VIP = 'key_vip_prod_456';
const KEY_ADMIN = 'key_admin_prod_789';

/**
 * SCENARIO 1: Comprehensive Edge Cases, Auth & Functional Integration
 */
export function testEdgeCasesAndFunctional() {
  group('1. Public Health Check (No Auth Required)', () => {
    const res = http.get(`${BASE_URL}/health`);
    const success = check(res, {
      'Health check status is 200': (r) => r.status === 200,
      'Postgres DB connected': (r) => r.json('database').includes('connected'),
      'BullMQ Redis connected': (r) => r.json('queue').includes('connected'),
      'Queue depth reported': (r) => typeof r.json('queueDepth') === 'number',
    });
    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('2. Phase 19 Security: Missing API Key Rejected (401)', () => {
    const res = http.post(`${BASE_URL}/jobs`, JSON.stringify({ image: 'sample.jpg' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const success = check(res, {
      'Missing API Key returns HTTP 401': (r) => r.status === 401,
      'Error code is UNAUTHORIZED': (r) => r.json('error') === 'UNAUTHORIZED',
    });
    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('3. Phase 19 Security: Tier-Enforced VIP Authorization (403)', () => {
    // Standard tier key attempting to request Priority 1 (VIP line cutting)
    const res = http.post(`${BASE_URL}/jobs`, JSON.stringify({ image: 'sample.jpg', priority: 1 }), {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': KEY_STD,
      },
    });
    const success = check(res, {
      'Standard key requesting VIP priority returns HTTP 403': (r) => r.status === 403,
      'Error code is FORBIDDEN_TIER': (r) => r.json('error') === 'FORBIDDEN_TIER',
    });
    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('4. Phase 19 Security: Path Traversal Attack Rejected (400)', () => {
    const res = http.post(`${BASE_URL}/jobs`, JSON.stringify({ image: '../../etc/passwd' }), {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': KEY_STD,
      },
    });
    const success = check(res, {
      'Path traversal rejected with HTTP 400': (r) => r.status === 400,
      'Error code is PATH_TRAVERSAL_DETECTED': (r) => r.json('error') === 'PATH_TRAVERSAL_DETECTED',
    });
    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  let createdJobId = null;
  const customTraceId = `k6-trace-${Date.now()}`;

  group('5. Valid Standard Priority Job Submission', () => {
    const payload = JSON.stringify({ image: 'sample.jpg', priority: 5 });
    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': KEY_STD,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    jobCreationDuration.add(res.timings.duration);

    const success = check(res, {
      'Normal job created with HTTP 201': (r) => r.status === 201,
      'Job ID starts with job-': (r) => r.json('id').startsWith('job-'),
      'Status is pending': (r) => r.json('status') === 'pending',
      'Response has X-Correlation-Id header': (r) => r.headers['X-Correlation-Id'] !== undefined || r.headers['x-correlation-id'] !== undefined,
    });

    if (success) {
      createdJobId = res.json('id');
      edgeCasesPassed.add(1);
    }
    errorRate.add(!success);
  });

  group('6. Valid VIP Priority Job with Custom Correlation ID', () => {
    const payload = JSON.stringify({ image: 'sample.jpg' });
    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': customTraceId,
        'X-API-Key': KEY_VIP,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    const returnTrace = res.headers['X-Correlation-Id'] || res.headers['x-correlation-id'];

    const success = check(res, {
      'VIP job created with HTTP 201': (r) => r.status === 201,
      'VIP tier assigned': (r) => r.json('tier') === 'vip',
      'Custom Correlation ID preserved in header': () => returnTrace === customTraceId,
      'Correlation ID matches in body': (r) => r.json('correlationId') === customTraceId,
    });

    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('7. Edge Case: Missing Image Field (Bad Request 400)', () => {
    const payload = JSON.stringify({});
    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': KEY_STD,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    const success = check(res, {
      'Empty payload rejected with HTTP 400': (r) => r.status === 400,
      'Error message mentions no image': (r) => r.json('error').includes('No image provided'),
    });

    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('8. Edge Case: Poison Pill (Missing Disk Image)', () => {
    const payload = JSON.stringify({ image: 'ghost-nonexistent-image.jpg', priority: 5 });
    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': KEY_STD,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    const success = check(res, {
      'Poison pill accepted asynchronously with HTTP 201': (r) => r.status === 201,
      'Job ID generated for tracking': (r) => r.json('id').startsWith('job-'),
    });

    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('9. Single Job Query & S3 Pre-signed URL Check', () => {
    if (createdJobId) {
      sleep(1); // Allow asynchronous BullMQ worker to claim and persist job to Neon DB
      const res = http.get(`${BASE_URL}/jobs/${createdJobId}`, {
        headers: { 'X-API-Key': KEY_STD },
      });
      const success = check(res, {
        'Fetch single job returns HTTP 200': (r) => r.status === 200,
        'Returned job ID matches': (r) => r.json('id') === createdJobId,
        'Job payload structure valid': (r) => r.json('payload') !== undefined,
      });

      if (success) edgeCasesPassed.add(1);
      errorRate.add(!success);
    }
  });

  group('10. Observability & Telemetry Endpoint (GET /metrics)', () => {
    const res = http.get(`${BASE_URL}/metrics`, {
      headers: { 'X-API-Key': KEY_STD },
    });
    const success = check(res, {
      'Metrics endpoint returns HTTP 200': (r) => r.status === 200,
      'Total jobs counted': (r) => typeof r.json('counts.total') === 'number',
      'Queue depth telemetry available': (r) => typeof r.json('queue.totalDepth') === 'number',
      'p50 turnaround latency computed': (r) => typeof r.json('latencies.totalTurnaroundMs.p50') === 'number',
      'p95 turnaround latency computed': (r) => typeof r.json('latencies.totalTurnaroundMs.p95') === 'number',
      'Throughput jobs/sec reported': (r) => typeof r.json('throughput.jobsPerSecond') === 'number',
    });

    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });

  group('11. Log Tracing by Correlation ID (GET /logs - Admin Only)', () => {
    const res = http.get(`${BASE_URL}/logs?correlationId=${customTraceId}`, {
      headers: { 'X-API-Key': KEY_ADMIN },
    });
    const success = check(res, {
      'Query logs returns HTTP 200 for Admin': (r) => r.status === 200,
      'Logs returned as array': (r) => Array.isArray(r.json()),
    });

    if (success) edgeCasesPassed.add(1);
    errorRate.add(!success);
  });
}

/**
 * SCENARIO 2: Concurrent Multi-User Load Test (Authenticated VUs)
 */
export function testConcurrentVirtualUsers() {
  const isVip = __VU % 3 === 0; // 1 in 3 VUs is a VIP user
  const apiKey = isVip ? KEY_VIP : KEY_STD;
  const correlationId = `k6-vu-${__VU}-iter-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    image: 'sample.jpg',
    type: 'thumbnail',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
      'X-API-Key': apiKey,
    },
  };

  const res = http.post(`${BASE_URL}/jobs`, payload, params);
  jobCreationDuration.add(res.timings.duration);

  // Checks for concurrent ingestion
  // Status can be 201 (Created), or 503 if Backpressure saturation is reached under load
  const ok = check(res, {
    'Accepted (201) or Load Shed (503 Backpressure)': (r) => r.status === 201 || r.status === 503,
  });

  errorRate.add(!ok);

  // Virtual user think time between requests (simulate realistic user behavior)
  sleep(0.3 + Math.random() * 0.4);
}
