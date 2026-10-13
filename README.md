# 🚀 Production-Grade Asynchronous Job Processing System

[![CI/CD Pipeline](https://github.com/Souma061/job_processing_system/actions/workflows/deploy.yml/badge.svg)](https://github.com/Souma061/job_processing_system/actions/workflows/deploy.yml)
[![Node.js](https://img.shields.io/badge/Node.js-v22.23-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-v7.0-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-2496ED.svg)](https://www.docker.com/)
[![AWS](https://img.shields.io/badge/AWS-EC2%20%7C%20S3-FF9900.svg)](https://aws.amazon.com/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

A high-performance, fault-tolerant distributed job processing architecture built with **TypeScript**, **BullMQ**, **Redis**, **Sharp**, **PostgreSQL**, and **AWS S3**. Designed from first principles to explore concurrency limits, bounded queue backpressure, compute pushdown, distributed locking, chaos engineering, and automated cloud deployments.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    Client([Client / Web Dashboard]) -->|HTTP Requests| API[Express API Gateway]
    
    subgraph Ingestion & Gateway Layer
        API --> Auth[API Key RBAC & Validation]
        Auth --> Backpressure[Bounded Queue & Backpressure Check]
        Backpressure --> Correlation[Trace Correlation ID Generator]
    end

    subgraph Message Broker Layer
        Correlation -->|Enqueue Job with Priority| RedisBroker[(BullMQ Redis Broker)]
        RedisBroker --> PriorityQueue[Priority ZSET Queue: VIP vs Normal]
    end

    subgraph Consumer Worker Pool
        PriorityQueue -->|Poll Job| Worker1[Sharp Worker Thread 1]
        PriorityQueue -->|Poll Job| Worker2[Sharp Worker Thread 2]
        Worker1 --> S3[(AWS S3 Private Storage)]
        Worker2 --> S3
    end

    subgraph Persistence & Telemetry Layer
        Worker1 -->|Persist JSONB Metrics| Postgres[(Neon PostgreSQL Primary)]
        Worker2 -->|Persist JSONB Metrics| Postgres
        Postgres -->|percentile_cont Pushdown| MetricsEngine[SQL Aggregator]
    end

    subgraph Caching & Observability
        LeaderLock[Cluster Leader Election SET NX PX] --> MetricsEngine
        MetricsEngine -->|10s Cache TTL| RedisCache[(Redis Cache)]
        API -.->|Read Metrics < 1ms| RedisCache
        API --> Pino[Pino Asynchronous Multi-Stream Logger]
        Pino --> Axiom[(Axiom Cloud Telemetry)]
    end
```

---

## ✨ Key Architectural Highlights

### 1. Queue-First Ingestion & Priority Scheduling
* **Decoupled Architecture:** Express API accepts payloads and returns `201 Created` in **$\approx 1\text{ ms}$**, delegating CPU-heavy image processing to asynchronous background workers.
* **Line-Cutting Priority Queue:** Backed by Redis Sorted Sets (ZSET). VIP customers cut ahead in line while preserving FIFO order within each priority tier. Under load testing, VIP jobs achieved **$\approx 14\text{ seconds}$ faster queue turnaround**.

### 2. Bounded Queues & Backpressure Defense
* Enforces hard queue capacity limits (`MAX_QUEUE_CAPACITY=50`) with dedicated reserve headroom for VIP jobs (`MAX_VIP_QUEUE_CAPACITY=100`).
* Throttles incoming ingestion with **`HTTP 429 Too Many Requests` / `HTTP 503 Service Unavailable`** with `Retry-After: 5` headers when workers are saturated, preventing server memory blowups.

### 3. Compute Pushdown (`percentile_cont` in PostgreSQL)
* Replaced an in-memory Node.js $O(N)$ row-fetching loop and $O(N \log N)$ array sorting with **in-database SQL pushdown**.
* Leverages PostgreSQL native `percentile_cont(0.50)`, `percentile_cont(0.95)`, `percentile_cont(0.99)`, and `COUNT(*) FILTER` to compute full-population telemetry in compiled C, reducing network payload from megabytes of row objects to **a single 1 KB scalar row**.

### 4. Cache Stampede Prevention (5-Pillar Refresher)
* Direct-to-database telemetry collapsed under concurrent load (32.2 RPS) due to connection pool starvation (`pg.Pool` max 10 connections).
* Solved with a **5-Pillar Background Refresher** ([`src/services/metrics-refresher.ts`](src/services/metrics-refresher.ts)):
  1. **Distributed Leader Lock:** Multi-instance cluster elects a single leader via `SET lock NX PX 4500`. Exactly 1 query runs every 4s across the cluster.
  2. **Drift-Free Loop:** Self-scheduling `setTimeout` in `finally` prevents query stacking.
  3. **In-Memory Stale Grace:** Survives Redis drops by serving `lastKnownGoodMetrics` with `isStale: true`.
  4. **Cold-Start Hydration:** Pre-warms cache before `app.listen()` accepts traffic.
  5. **Telemetry Badging:** Real-time data age tracking (`dataAgeMs`).

### 5. Distributed Tracing & 12-Factor Logging
* Generates cryptographic `correlationId` tokens (`corr-uuid`) upon HTTP ingestion.
* Asynchronously propagates correlation tokens across HTTP boundaries, BullMQ job payloads, Sharp workers, and S3 uploads.
* 12-Factor non-blocking multi-streaming via **Pino**: emits unbuffered NDJSON to `process.stdout`, asynchronously writes to disk, and streams telemetry batches to **Axiom Cloud**.

### 6. Automated Chaos Engineering & Circuit Breakers
* Built-in 500ms fail-fast circuit breakers on Redis reads and 1,500ms timeouts on queue ingestion.
* Validated under live k6 chaos testing where the Redis container was frozen (`docker pause`):
  * **8,412 requests** handled with **100.00% assertion pass rate**.
  * **Strictly 0.00% unhandled 500 server crashes**.
  * 61 requests seamlessly served stale grace metrics; 3,589 requests received graceful `503 QUEUE_UNAVAILABLE` with backoff hints.

---

## 📊 Empirical Benchmarks

| Test Scenario | Architecture | Throughput | Avg Latency | p99 Tail Latency | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Telemetry Endpoint** *(10k requests, 200 concurrency)* | Direct-to-DB Pushdown | 32.2 req/sec | 2,975 ms | 4,738 ms | 🔴 Pool Starvation |
| **Telemetry Endpoint** *(10k requests, 200 concurrency)* | **Pushdown + Refresher Cache** | **1,822.5 req/sec** | **109 ms** | **176 ms** | **⚡ 56x Faster** |
| **Telemetry + Async Logging** *(10k requests, 200 concurrency)* | **Pino Multi-Stream Pipeline** | **2,522.7 req/sec** | **79 ms** | **145 ms** | **⚡ 78x Faster** |
| **Live Chaos Injection** *(Redis Frozen for 12s)* | **Fail-Fast Circuit Breakers** | **152.9 req/sec** | **100% Checks Passed** | **0.00% Crashes** | **🛡️ Self-Healing** |

---

## 🛠️ Tech Stack & Infrastructure

| Layer | Technologies |
| :--- | :--- |
| **Runtime & Language** | Node.js 22 (LTS), TypeScript 7, pnpm 12 |
| **Web Framework** | Express 5, Multer |
| **Queue & Broker** | BullMQ 6, Redis 7 (AOF Persistence) |
| **Image Processing** | Sharp 0.35 (libvips C++ native bindings) |
| **Database** | Neon PostgreSQL (Serverless over SSL, JSONB telemetry) |
| **Cloud Storage** | AWS S3 (Private buckets + Presigned GET URLs) |
| **Observability** | Pino 10, Axiom Cloud Logging, RedisInsight |
| **Containerization** | Docker (Multi-stage Alpine), Docker Compose |
| **Hosting & CI/CD** | AWS EC2 (Ubuntu 24.04), GitHub Actions |
| **Testing** | Grafana k6, tsx test suites |

---

## 🚀 Getting Started

### Prerequisites
* [Node.js 22+](https://nodejs.org/)
* [pnpm 12+](https://pnpm.io/)
* [Docker & Docker Compose](https://www.docker.com/)

### 1. Clone & Install
```bash
git clone https://github.com/Souma061/job_processing_system.git
cd job_processing_system
pnpm install
```

### 2. Environment Configuration
Create a `.env` file in the project root (see [`.env.example`](.env.example)):

```env
PORT=3000
NODE_ENV=production

# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://user:password@host/neondb?sslmode=require

# AWS S3 Storage
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_S3_BUCKET_NAME=your-bucket-name

# Redis Broker (Use 'redis' if running inside Docker Compose)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Security & API Key RBAC
API_KEY_STANDARD=key_std_prod_123
API_KEY_VIP=key_vip_prod_456
API_KEY_ADMIN=key_admin_prod_789

# Queue Capacity Limits
MAX_QUEUE_CAPACITY=50
MAX_VIP_QUEUE_CAPACITY=100

# Optional: Axiom Cloud Logging
AXIOM_DATASET=job-processing-system
AXIOM_TOKEN=xaat-your-token
```

### 3. Run with Docker Compose (Recommended)
Launch the entire stack (Redis, RedisInsight, and the API container):

```bash
docker compose up -d --build
```

Access the services:
* **Web Dashboard:** `http://localhost:3000`
* **Healthcheck:** `http://localhost:3000/health`
* **RedisInsight GUI:** `http://localhost:5540`

---

## 🧪 Automated Test Suites

The repository contains automated test harnesses to evaluate system limits:

```bash
# Test 1: Real-time telemetry & latency distributions (p50/p95/p99)
pnpm test:metrics

# Test 2: Bounded queue backpressure & saturation defense
pnpm test:backpressure

# Test 3: High-concurrency cache stampede benchmark
pnpm test:stampede

# Test 4: End-to-end security, path traversal & RBAC test suite (26 assertions)
pnpm test:security

# Test 5: Distributed correlation tracing & poison pill isolation
pnpm test:correlation

# Test 6: Containerized k6 integration & stress tests
pnpm test:k6
pnpm test:stress

# Test 7: Live chaos test with Redis pause/unpause injection
pnpm test:chaos
```

---

## 📡 API Reference

All protected endpoints require an `X-API-Key` header mapped to an authorized role.

| Method | Endpoint | Auth Tier | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | Container health probe & connection check |
| `POST` | `/jobs` | Standard / VIP | Enqueue image thumbnail job (multipart/form-data or JSON) |
| `GET` | `/jobs` | Standard / VIP | List all jobs with AWS S3 presigned thumbnail URLs |
| `GET` | `/jobs/:id` | Standard / VIP | Retrieve details and timings for a specific job |
| `DELETE` | `/jobs` | **Admin** | Cascading cleanup of database jobs and physical S3 thumbnails |
| `GET` | `/metrics` | Standard / VIP | Real-time queue depths, throughput, and $p50/p95/p99$ percentiles |
| `GET` | `/logs` | **Admin** | Query structured log events (supports `?correlationId=` & `?level=`) |

---

## 🔄 CI/CD Pipeline

The project features automated Continuous Integration and Continuous Deployment via **GitHub Actions** ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):

1. **CI Stage:** Runs on all Pull Requests and pushes to `main`. Executes TypeScript strict typechecking (`tsc --noEmit`), project compilation, and validates the multi-stage Docker build.
2. **CD Stage:** Gated to `main`. Connects securely to the AWS EC2 instance over SSH, pulls the latest commit, executes a zero-downtime rebuild (`docker compose up -d --build api`), and gates completion on a live `/health` curl check.

---

## 📖 Deep Dives & Field Notes

* **[BLOG.md](BLOG.md)**: Deep dive on *Node.js In-Memory Math vs. PostgreSQL `percentile_cont` Pushdown* (The 56x Throughput Leap).
* **[learnings.md](learnings.md)**: Comprehensive architectural journal documenting all 22 breakthroughs, edge-case failure modes, and lessons learned from Phase 0 to Phase 24.

---

## 📄 License

This project is licensed under the [ISC License](LICENSE).

