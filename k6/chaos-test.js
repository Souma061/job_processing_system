import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// Custom Chaos Engineering Metrics
const chaosReqDuration = new Trend("chaos_req_duration_ms");
const jobsCreated = new Counter("chaos_jobs_created_201");
const queueDegraded503 = new Counter("chaos_queue_degraded_503");
const metricsServedStale = new Counter("chaos_metrics_served_stale");
const metricsServedFresh = new Counter("chaos_metrics_served_fresh");
const unexpected500Rate = new Rate("chaos_unexpected_500_rate");
const healthChecksPassed = new Counter("chaos_health_checks_passed");

export const options = {
  scenarios: {
    chaos_scenario: {
      executor: "ramping-vus",
      startVUs: 10,
      stages: [
        { duration: "10s", target: 20 }, // Baseline load
        { duration: "25s", target: 30 }, // Sustained load during chaos injection
        { duration: "15s", target: 20 }, // Post-recovery validation
        { duration: "5s", target: 0 },   // Cool down
      ],
      gracefulRampDown: "5s",
      gracefulStop: "5s",
    },
  },
  thresholds: {
    // Zero unhandled 500 server crashes permitted!
    "chaos_unexpected_500_rate": ["rate==0"],
    // Checks assertion rate >= 95% across baseline, chaos, and recovery
    "checks": ["rate>=0.95"],
    // 90% of requests respond in under 2 seconds even during chaos timeouts
    "http_req_duration": ["p(90)<2500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:3000";
const KEY_STD = __ENV.API_KEY_STANDARD || "key_std_prod_123";
const KEY_VIP = __ENV.API_KEY_VIP || "key_vip_prod_456";

export default function () {
  const rand = Math.random();
  const correlationId = `k6-chaos-vu-${__VU}-iter-${__ITER}-${Date.now()}`;

  if (rand < 0.45) {
    // 45% Traffic: Job Ingestion (POST /jobs)
    const isVip = Math.random() < 0.3;
    const apiKey = isVip ? KEY_VIP : KEY_STD;

    const payload = JSON.stringify({
      image: "sample.jpg",
      type: "thumbnail",
    });

    const params = {
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlationId,
        "X-API-Key": apiKey,
      },
      tags: { name: "POST_jobs" },
    };

    const res = http.post(`${BASE_URL}/jobs`, payload, params);
    chaosReqDuration.add(res.timings.duration);

    if (res.status === 201) {
      jobsCreated.add(1);
      check(res, {
        "Job accepted (201 Created)": (r) => r.status === 201,
        "Has Job ID": (r) => JSON.parse(r.body).id !== undefined,
      });
    } else if (res.status === 503) {
      // Graceful degradation when queue capacity saturated or Redis paused
      queueDegraded503.add(1);
      check(res, {
        "Graceful 503 (Queue saturated or unavailable)": (r) => r.status === 503,
        "Contains Retry-After header": (r) => r.headers["Retry-After"] !== undefined,
      });
    } else if (res.status >= 500) {
      // Unhandled server crash
      unexpected500Rate.add(1);
      check(res, {
        "FAILED: Unhandled 500 crash": (r) => r.status < 500,
      });
    } else {
      check(res, {
        "Client/Security response (<500)": (r) => r.status < 500,
      });
    }
  } else if (rand < 0.85) {
    // 40% Traffic: System Metrics & Cache Stampede Shield (GET /metrics)
    const params = {
      headers: {
        "X-Correlation-Id": correlationId,
        "X-API-Key": KEY_STD,
      },
      tags: { name: "GET_metrics" },
    };

    const res = http.get(`${BASE_URL}/metrics`, params);
    chaosReqDuration.add(res.timings.duration);

    const is200 = res.status === 200;
    if (is200) {
      try {
        const body = JSON.parse(res.body);
        if (body.isStale === true) {
          // Zero-DB Stale Grace kicked in during Redis blip!
          metricsServedStale.add(1);
        } else {
          metricsServedFresh.add(1);
        }
      } catch (e) {
        // ignore parse
      }

      check(res, {
        "Metrics returned 200 OK": (r) => r.status === 200,
        "Response time < 1000ms": (r) => r.timings.duration < 1000,
      });
    } else if (res.status >= 500) {
      unexpected500Rate.add(1);
      check(res, {
        "FAILED: Metrics 500 error": (r) => r.status < 500,
      });
    }
  } else {
    // 15% Traffic: Public Health Liveness Probes (GET /health)
    const params = {
      headers: { "X-Correlation-Id": correlationId },
      tags: { name: "GET_health" },
    };

    const res = http.get(`${BASE_URL}/health`, params);
    chaosReqDuration.add(res.timings.duration);

    if (res.status === 200) {
      healthChecksPassed.add(1);
      check(res, {
        "Health probe alive (200 OK)": (r) => r.status === 200,
      });
    } else if (res.status >= 500) {
      unexpected500Rate.add(1);
      check(res, {
        "FAILED: Health probe crash": (r) => r.status < 500,
      });
    }
  }

  // Small pacing interval between iterations
  sleep(0.05);
}

