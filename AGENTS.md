# AGENTS.md — SatellitePlanner Environment & Operational Guide

This document records the environment configuration, portable toolchain locations, database migration behavior, real-time notification pipeline, and startup/verification commands for future agent sessions.

---

## 1. Environment Status & Portable Toolchain

- **OS**: Windows (PowerShell)
- **System-wide Node.js / Docker**: Neither Node.js nor Docker Desktop is installed globally on this host.
- **Portable Binaries Installed in Workspace (`.tools/`)**:
  - **Node.js `v22.14.0`**: `.tools\node-v22.14.0-win-x64\node.exe` and `.tools\node-v22.14.0-win-x64\npm.cmd`
    - *Note*: `.ps1` wrapper scripts in `.tools\node-v22.14.0-win-x64\` were removed so PowerShell uses `npm.cmd` and `npx.cmd` without `ExecutionPolicy` blocks.
  - **NATS Server `v2.10.24`**: `.tools\nats-server-v2.10.24-windows-amd64\nats-server.exe`

To make `node` and `npm` available in any new PowerShell session:
```powershell
$env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"
```

---

## 2. Database Migration & Seed Strategy

- **Schema & Seed File**: `backend/src/db/init.sql`
  - Creates table `geo_events` (`id UUID PRIMARY KEY`, `title VARCHAR(255)`, `latitude DECIMAL(9,6)`, `longitude DECIMAL(9,6)`, `intensity FLOAT`, `created_at TIMESTAMPTZ`) and seeds **16 globally distributed satellite ground station events**.
  - Creates table `satellite_fleet` and seeds **30 polar-orbiting satellites** (`SAT-POLAR-01` .. `SAT-POLAR-30`) evenly spaced every 6° of orbital plane longitude (`-90°` to `+84°`).
  - Creates table `users` (`id UUID PRIMARY KEY`, `name VARCHAR(255) NOT NULL`) seeded with two rows: `system` (`c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01`) and `demo` (`c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02`).
  - Creates table `acquisition_plan` (`id`, `satellite_id`, `user_id`, `acquisition_timestamp`, `duration_seconds`, `center_longitude_deg`, `center_latitude_deg`, `width_m`, `height_m`, `status`, `acquired_image`).
- **Automatic Execution**:
  - **Local / Portable Mode**: On backend startup (`backend/src/db/index.ts`), `initDatabase()` attempts to connect to `DATABASE_URL` (`postgresql://postgres:postgres@localhost:5432/app_db`). If unreachable, it automatically activates an in-memory PostgreSQL fallback (`pg-mem`) and runs `backend/src/db/init.sql` automatically.
  - **Docker Mode**: `docker-compose.yml` mounts `./backend/src/db/init.sql` to `/docker-entrypoint-initdb.d/init.sql:ro` inside `postgres:16-alpine` and also runs `initDatabase()` idempotently (`CREATE TABLE IF NOT EXISTS` / `ON CONFLICT (id) DO NOTHING`) when the backend starts.

---

## 2b. Real-Time Acquisition Plan Notification Pipeline (NATS JetStream + SSE)

- **Design Choice**: Instead of periodic frontend polling, real-time acquisition state changes (`Pending` → `Acquiring` → `Completed`) are pushed from the server using **NATS JetStream** + **Server-Sent Events (SSE)**.
- **How It Works**:
  1. **Event-Driven Executor (`backend/src/services/acquisitionExecutor.ts`)**: Sleeps until the next scheduled transition (`T - D/2` for `Acquiring`, `T + D/2` for `Completed` + `256×256` satellite image capture). Immediately after updating PostgreSQL, it calls `publishAcquisitionUpdated(updatedRow)`.
  2. **NATS JetStream (`backend/src/events/nats.ts`)**: `initNats()` provisions `ACQUISITION_STREAM` (subject `acquisition.plan.>`). `publishAcquisitionUpdated()` publishes the updated row JSON to `acquisition.plan.updated`.
  3. **JetStream Consumer & SSE Fan-Out (`backend/src/events/nats.ts` & `backend/src/controllers/geoEventsController.ts`)**: `startAcquisitionStreamConsumer()` consumes messages from `ACQUISITION_STREAM` (`acquisition.plan.updated`) and broadcasts each row as an SSE `data: <JSON>\n\n` frame to all clients connected to `GET /api/v1/acquisition-plan/stream` (with an automatic in-process fallback if NATS is temporarily unavailable).
  4. **Frontend Subscription (`frontend/src/services/api.ts` & `frontend/src/App.tsx`)**: On mount, `App.tsx` opens an `EventSource` via `subscribeToAcquisitionUpdates()` and patches the updated `AcquisitionPlanRow` into React state (`setAcquisitionPlan`). Because the **Global Acquisition Plan** floating window, the **Satellite Information Panel**, and the **3D Globe** pulsing target halo derive their state via `useMemo` from `acquisitionPlan`, all open UI views update in real time without manual refresh.

---

## 3. Build Commands

Run from the workspace root (`c:\Users\Salva\Documents\Antigravity\SatellitePlanner`):

```powershell
# 1. Prepend portable Node.js to PATH
$env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"

# 2. Build Backend (TypeScript -> backend/dist)
Set-Location backend
npm.cmd run build
Set-Location ..

# 3. Build Frontend (TypeScript + Vite -> frontend/dist)
Set-Location frontend
npm.cmd run build
Set-Location ..
```

---

## 4. Startup Commands

### Option A: Unified Portable Stack Launcher (Recommended on this Host)
Starts NATS JetStream (`:4222` / `:8222`), Backend API (`:3001`), and Frontend Vite Dev Server (`:5173`) together:

```powershell
# Start all services:
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
# (Or double-click start-local.bat / run: .\.tools\node-v22.14.0-win-x64\node.exe .\run-stack.mjs)

# Stop all services cleanly:
powershell -ExecutionPolicy Bypass -File .\stop-local.ps1
# (Or double-click stop-local.bat)
```

### Option B: Individual Service Startup Commands (Portable Mode)

1. **Start NATS Server with JetStream enabled**:
   ```powershell
   .\.tools\nats-server-v2.10.24-windows-amd64\nats-server.exe -js -m 8222 -sd .\nats-data
   ```

2. **Start Backend REST API + Durable JetStream Consumer (`http://localhost:3001`)**:
   ```powershell
   $env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"
   .\.tools\node-v22.14.0-win-x64\node.exe backend/dist/index.js
   ```
   *(Or in watch mode during development)*:
   ```powershell
   $env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"
   Set-Location backend
   npm.cmd run dev
   ```

3. **Start Frontend 3D Globe Dev Server (`http://localhost:5173`)**:
   ```powershell
   $env:PATH = "$PWD\.tools\node-v22.14.0-win-x64;$env:PATH"
   Set-Location frontend
   npm.cmd run dev
   ```

### Option C: Docker Compose (When Docker Desktop is Available)
```powershell
Copy-Item .env.example .env -ErrorAction SilentlyContinue
docker compose up --build -d
docker compose ps
```

---

## 5. Verification & Healthcheck Commands

```powershell
# Check PostgreSQL & NATS JetStream health
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/health" | ConvertTo-Json -Depth 5

# Query paginated geo-events from PostgreSQL
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/geo-events?page=1&limit=10" | ConvertTo-Json -Depth 5

# Publish a new geo-event to NATS JetStream (geo.events.created)
$body = @{
  title = "Canary Islands Deep Space Optical Link"
  latitude = 28.2916
  longitude = -16.6291
  intensity = 0.97
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/api/v1/geo-events" -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5

# Check aggregate metrics and JetStream counters
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/metrics" | ConvertTo-Json -Depth 5
```
