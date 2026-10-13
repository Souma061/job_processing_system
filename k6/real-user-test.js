import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

// ============================================================================
// Custom User-Centric Metrics
// ============================================================================
const userJourneyDuration = new Trend('user_journey_duration_ms');
const jobCreationLatency = new Trend('job_creation_latency_ms');
const jobPollingLatency = new Trend('job_polling_latency_ms');
const activeVUsGauge = new Gauge('current_active_users');

const jobsSubmitted = new Counter('jobs_submitted_total');
const jobsCompleted = new Counter('jobs_completed_total');
const jobsBackpressured = new Counter('jobs_backpressured_503_total');
const unhandledErrorRate = new Rate('unhandled_error_rate');

// ============================================================================
// Realistic User Ramp-Up Stages
// ============================================================================
export const options = {
  scenarios: {
    real_user_traffic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 20 },   // Stage 1: Warmup (20 concurrent active users ~ 200 daily browsing users)
        { duration: '30s', target: 50 },   // Stage 2: Normal peak (50 concurrent users ~ 500 browsing users)
        { duration: '30s', target: 100 },  // Stage 3: Heavy surge (100 concurrent users ~ 1,000 browsing users)
        { duration: '30s', target: 200 },  // Stage 4: Flash crowd (200 concurrent users ~ 2,000 browsing users)
        { duration: '15s', target: 0 },    // Stage 5: Recovery and cooldown
      ],
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    // 95% of job submissions respond in under 3.5 seconds
    'job_creation_latency_ms': ['p(95)<3500'],
    // System must not crash: unhandled 500 errors must be strictly under 1%
    'unhandled_error_rate': ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://3.7.248.11:3000';
const KEY_STD = __ENV.API_KEY_STANDARD || 'key_std_prod_123';
const KEY_VIP = __ENV.API_KEY_VIP || 'key_vip_prod_456';

export default function () {
  const startTime = Date.now();
  const isVip = Math.random() < 0.20; // 20% are VIP customers, 80% are standard
  const apiKey = isVip ? KEY_VIP : KEY_STD;
  const userTag = isVip ? 'VIP' : 'Standard';
  const correlationId = `k6-user-${__VU}-${__ITER}-${Date.now()}`;

  activeVUsGauge.set(__VU);

  // --------------------------------------------------------------------------
  // Step 1: User visits the dashboard (browses stats & recent jobs)
  // --------------------------------------------------------------------------
  group('1. Browse Dashboard & Jobs', function () {
    const healthRes = http.get(`${BASE_URL}/health`);
    check(healthRes, { 'Health status is 200': (r) => r.status === 200 });

    const metricsRes = http.get(`${BASE_URL}/metrics`, {
      headers: { 'X-API-Key': apiKey },
    });
    check(metricsRes, { 'Metrics status is 200': (r) => r.status === 200 });

    const listRes = http.get(`${BASE_URL}/jobs?limit=10`, {
      headers: { 'X-API-Key': apiKey },
    });
    check(listRes, { 'Job list status is 200': (r) => r.status === 200 });
  });

  // Human think time (1 - 2 seconds before clicking upload)
  sleep(1.0 + Math.random() * 1.0);

  // --------------------------------------------------------------------------
  // Step 2: User enqueues an image for thumbnail generation
  // --------------------------------------------------------------------------
  let createdJobId = null;

  group('2. Enqueue Image Job', function () {
    const payload = JSON.stringify({
      image: 'sample.jpg',
      type: 'thumbnail',
      priority: isVip ? 1 : 5,
    });

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Correlation-Id': correlationId,
      },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    jobCreationLatency.add(res.timings.duration);
    jobsSubmitted.add(1);

    if (res.status === 201) {
      // Job accepted!
      const body = res.json();
      createdJobId = body.id;
      check(res, {
        'Job accepted (201)': (r) => r.status === 201,
        'Got Job ID': () => createdJobId !== null,
        'Correlation ID matches': (r) => {
          const hdr = r.headers['X-Correlation-Id'] || r.headers['x-correlation-id'];
          return hdr === correlationId;
        },
      });
      unhandledErrorRate.add(false);
    } else if (res.status === 503) {
      // Healthy Backpressure: Queue is full (exceeded 50 normal or 100 VIP)
      jobsBackpressured.add(1);
      const retryHeader = res.headers['Retry-After'] || res.headers['retry-after'];
      check(res, {
        'Graceful Backpressure (503)': (r) => r.status === 503,
        'Has Retry-After header': () => retryHeader !== undefined,
      });
      unhandledErrorRate.add(false);
    } else {
      // Unhandled failure (e.g. 500 Internal Server Error)
      check(res, { 'Unexpected server error': () => false });
      unhandledErrorRate.add(true);
    }
  });

  // --------------------------------------------------------------------------
  // Step 3: If accepted, user polls for thumbnail completion
  // --------------------------------------------------------------------------
  if (createdJobId) {
    group('3. Poll Job Status', function () {
      // User waits a couple seconds then checks status
      sleep(1.5 + Math.random() * 1.5);

      const pollRes = http.get(`${BASE_URL}/jobs/${createdJobId}`, {
        headers: { 'X-API-Key': apiKey },
      });
      jobPollingLatency.add(pollRes.timings.duration);

      const pollBody = pollRes.json();
      if (pollRes.status === 200) {
        check(pollRes, { 'Status poll successful (200)': (r) => r.status === 200 });
        if (pollBody.status === 'completed') {
          jobsCompleted.add(1);
        }
        unhandledErrorRate.add(false);
      } else {
        unhandledErrorRate.add(true);
      }
    });
  }

  // End-to-end journey duration
  userJourneyDuration.add(Date.now() - startTime);

  // Think time before user does their next task
  sleep(1.0 + Math.random() * 1.5);
}
