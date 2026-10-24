# SatellitePlanner — Event-Driven 3D Geospatial Telemetry Platform

A production-ready full-stack prototype combining an **event-driven Node.js + TypeScript REST API**, **NATS JetStream** durable message streaming, **PostgreSQL** persistence, and an interactive **3D Earth WebGL visualizer** built with **React, TypeScript, Three.js, and Globe.gl**.

---

## Architecture & Directory Structure

```text
├── docker-compose.yml          # PostgreSQL 16, NATS JetStream (-js), Backend API
├── .env.example                # Environment variable template
├── start-local.ps1             # Zero-install portable stack launcher (NATS + Backend + Frontend)
├── /backend                    # Node.js (TypeScript + Express + pg + NATS JetStream)
│   ├── src/
│   │   ├── config/             # Environment, DB, and NATS stream configuration
│   │   ├── db/                 # PostgreSQL connection pool, init.sql migration & 16 global seed points
│   │   ├── events/             # NATS JetStream publisher & durable background consumer
│   │   ├── controllers/        # REST controllers (health, metrics, geo-events)
│   │   └── routes/             # REST endpoints (/api/v1/health, /api/v1/metrics, /api/v1/geo-events)
│   ├── Dockerfile
│   └── package.json
└── /frontend                   # Vite + React + TypeScript + Three.js + Globe.gl
    ├── src/
    │   ├── components/         # GlobeVisualizer.tsx (3D WebGL Earth, arcs, heat pillars, rings)
    │   ├── services/           # Typed REST API client
    │   └── App.tsx             # Command Center HUD, NATS event publisher form, and 3D marker inspector
    └── package.json
```

---

## Key Features

1. **NATS JetStream Event-Driven Pipeline**:
   - Automatically provisions the `GEO_STREAM` stream targeting `geo.events.>`.
   - `POST /api/v1/geo-events` validates incoming telemetry coordinates and publishes to `geo.events.created`.
   - A durable JetStream consumer (`geo-events-postgres-writer`) asynchronously consumes `geo.events.created` messages, persists them into PostgreSQL (`geo_events` table), and acknowledges each message (`msg.ack()`).
2. **PostgreSQL 16 + Automatic In-Memory Fallback**:
   - Uses `pg.Pool` connection pooling and automatically runs `backend/src/db/init.sql` on startup, seeding **16 globally distributed satellite ground station events** (Tokyo, Madrid, New York, São Paulo, Sydney, London, Cairo, Mumbai, Singapore, Nairobi, Buenos Aires, San Francisco, Reykjavik, Johannesburg, Seoul, Svalbard).
   - If a local or Docker PostgreSQL server is unreachable, the backend transparently falls back to an in-memory PostgreSQL engine (`pg-mem`) with identical schema and seed data so the stack runs anywhere out of the box.
3. **Interactive 3D Earth Visualizer (`Globe.gl` / `Three.js`)**:
   - High-contrast 3D Earth with atmospheric glow, bump topology, orbit controls (smooth drag, zoom, auto-rotation toggle), glowing 3D intensity pillars, pulsing telemetry rings, and animated orbital relay arcs.
   - Clicking any 3D marker or feed item smoothly flies the camera to the coordinates and opens a telemetry inspection modal.
4. **30-Satellite Polar Constellation & Event-Driven Acquisition Plan**:
   - Models 30 polar-orbiting satellites (`SAT-POLAR-01` .. `SAT-POLAR-30`) distributed across 30 orbital planes (6° longitude spacing) with live sub-satellite footprints (`300 km × 300 km`), user attribution (`users` table seeded with `system` and `demo`), and a 3-hour `acquisition_plan` schedule.
   - An event-driven background executor (`backend/src/services/acquisitionExecutor.ts`) wakes up strictly at `T - D/2` (transitioning the row to `Acquiring`) and `T + D/2` (fetching a real `256×256` satellite image tile of the target coordinates and transitioning the row to `Completed`).
5. **Real-Time Acquisition Plan Notifications (NATS JetStream + Server-Sent Events)**:
   - When an acquisition changes state (`Pending` → `Acquiring` → `Completed`), the backend publishes the updated row to NATS JetStream (`ACQUISITION_STREAM`, subject `acquisition.plan.updated`) and streams it to connected browsers via Server-Sent Events (`GET /api/v1/acquisition-plan/stream`), updating the **Global Acquisition Plan** window, **Satellite Information Panel**, and **3D Globe** target halo immediately without polling.

---

## Architectural Decision: Real-Time Acquisition Plan Updates (NATS JetStream + SSE vs. Periodic Polling)

### Why NATS JetStream + Server-Sent Events (Option 1) Was Chosen Over Periodic Polling
To keep the **Global Acquisition Plan** floating window, the **Satellite Information Panel**, and the **3D Globe** target halo synchronized as acquisitions transition through `Pending` → `Acquiring` → `Completed`, two approaches were evaluated:

1. **Server-Driven Push Notifications via NATS JetStream + SSE (Chosen)**:
   - **Zero Latency**: The backend executor (`backend/src/services/acquisitionExecutor.ts`) already schedules exact timers for `T - D/2` (`Acquiring`) and `T + D/2` (`Completed`). Publishing an event at the exact moment a database transition completes delivers sub-10ms UI updates.
   - **Minimal Bandwidth & Database Load**: Instead of repeatedly querying and transferring all 120 `acquisition_plan` rows (including `256×256` base64-encoded satellite imagery) every few seconds when nothing has changed, only the single modified `AcquisitionPlanRow` is pushed when a transition actually occurs.
   - **Multi-Instance & Multi-Consumer Scalability via NATS JetStream**: By publishing transitions to the `ACQUISITION_STREAM` (`acquisition.plan.updated`), any number of backend API instances or downstream microservices can consume the stream and fan out updates to their connected browser clients.
   - **Native Browser Reconnection**: Standard HTML5 `EventSource` (`GET /api/v1/acquisition-plan/stream`) operates over standard HTTP, requires no external WebSocket libraries, and automatically reconnects if the connection drops.
2. **Periodic HTTP Polling from the Web App (Rejected)**:
   - Introduces a trade-off between stale UI state (up to `N` seconds delay) and unnecessary HTTP/PostgreSQL load from polling 120 rows + base64 images on a fixed interval.

### How the End-to-End Pipeline Works

```text
[acquisitionExecutor.ts]
   │  (Timer fires at T - D/2 or T + D/2 -> UPDATE acquisition_plan SET status = ...)
   ▼
[publishAcquisitionUpdated()]  (backend/src/events/nats.ts)
   │  Publishes JSON payload to NATS JetStream
   ▼
[NATS JetStream: ACQUISITION_STREAM]  (subject: acquisition.plan.updated)
   │  Consumed asynchronously by startAcquisitionStreamConsumer()
   ▼
[broadcastAcquisitionUpdateToSseClients()]
   │  Writes `data: <AcquisitionPlanRow JSON>\n\n` to open HTTP streams
   ▼
[GET /api/v1/acquisition-plan/stream]  (Server-Sent Events endpoint)
   │  Received by browser `EventSource` in `subscribeToAcquisitionUpdates()`
   ▼
[React State (`setAcquisitionPlan` in App.tsx)]
   ├─► Updates Global Acquisition Plan floating window (live status badge & filter)
   ├─► Updates Satellite Information Panel (status badge & unlocks "Show Image" button)
   └─► Updates 3D Globe target footprint pulsing halo color (#fbbf24 -> #38bdf8 -> #34d399)
```

---

## Quick Start

### Option A: Run with Docker Compose (Full Containerized Stack)

```bash
cp .env.example .env
docker compose up --build -d
```

Then start the frontend dev server:

```bash
cd frontend
npm install
npm run dev
```

### Option B: Run Locally (Portable Zero-Install Mode on Windows)

This repository includes portable binaries in `.tools/` (Node.js v22.14.0 & NATS Server v2.10.24) so you can run the entire stack without global dependencies:

```powershell
.\start-local.ps1
```

- **Frontend 3D Command Center**: `http://localhost:5173`
- **Backend REST API**: `http://localhost:3001`
- **NATS JetStream Monitoring**: `http://localhost:8222/jsz`

---

## REST API Reference

### 1. Health Check
`GET /api/v1/health`
Returns connection status for PostgreSQL and NATS JetStream (`GEO_STREAM`).

### 2. List Geo-Events (Paginated)
`GET /api/v1/geo-events?page=1&limit=50`
Returns historical records ordered by `created_at DESC` along with pagination metadata.

### 3. Publish New Geo-Event (NATS JetStream Ingestion)
`POST /api/v1/geo-events`
```bash
curl -X POST http://localhost:3001/api/v1/geo-events \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Canary Islands Deep Space Optical Link",
    "latitude": 28.2916,
    "longitude": -16.6291,
    "intensity": 0.97
  }'
```

### 4. Telemetry & Stream Metrics
`GET /api/v1/metrics`
Returns aggregate intensity metrics from PostgreSQL and NATS JetStream published/consumed counters.

### 5. Users & Acquisition Plan Endpoints
- `GET /api/v1/users`: Returns registered users (`system`, `demo`).
- `POST /api/v1/acquisition-plan/init`: Clears old entries, generates 4 planned acquisitions per satellite across the next 3 hours (assigned to `system`), and starts the event-driven acquisition executor.
- `GET /api/v1/acquisition-plan`: Lists all planned acquisitions ordered chronologically (optionally filtered by `?satellite_id=...`).
- `GET /api/v1/acquisition-plan/:id`: Retrieves a single acquisition row by UUID.
- `GET /api/v1/acquisition-plan/stream`: **Server-Sent Events (SSE)** stream backed by NATS JetStream (`ACQUISITION_STREAM` / `acquisition.plan.updated`) that pushes real-time `AcquisitionPlanRow` JSON updates whenever an acquisition transitions to `Acquiring` or `Completed`.
