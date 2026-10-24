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
