import crypto from 'crypto';
import { Request, Response } from 'express';
import { getPool, checkDbHealth } from '../db';
import {
  publishGeoEventCreated,
  checkNatsHealth,
  registerAcquisitionSseClient,
  publishAcquisitionUpdated,
  publishAcquisitionCanceled,
  publishSatelliteStatusUpdated,
} from '../events/nats';
import { startAcquisitionPlanExecutor } from '../services/acquisitionExecutor';
import {
  triggerRequestQueueProcessor,
  clearReservationTimer,
  clearAllReservationTimers,
  fetchCurrentRequestQueue,
  broadcastCurrentRequestQueue,
  markOriginalAcquisitionAsReprogrammed,
  reprogramPendingAcquisitionsForDisabledSatellite,
  reassignEarlierAcquisitionsToReactivatedSatellite,
} from '../services/requestQueueProcessor';
import { isPointOnLand } from '../utils/landMask';

const ORBIT_PERIOD_MINUTES = 97;
const COVERAGE_SIZE_METERS = 300_000; // 300 km x 300 km satellite footprint
const METERS_PER_DEG_LAT = 111_320;
const DEFAULT_SYSTEM_USER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01';
const DEFAULT_DEMO_USER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02';

function normalizeLongitude(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

interface SatelliteRow {
  id: string;
  orbit_altitude_km: number;
  orbit_orientation_deg: number;
  reference_latitude_deg: number;
  reference_direction: 1 | -1;
  reference_timestamp: string;
}

/**
 * Computes the sub-satellite point (latitude, longitude) at targetTimeMs using the same
 * polar orbital propagation model as the frontend 3D visualization.
 */
function computeSatelliteSubpoint(
  sat: SatelliteRow,
  targetTimeMs: number
): { lat: number; lng: number } {
  const refMs = new Date(sat.reference_timestamp).getTime();
  const elapsedMinutes = (targetTimeMs - refMs) / 60_000;
  const orbitsElapsed = elapsedMinutes / ORBIT_PERIOD_MINUTES;

  const rawLat = sat.reference_latitude_deg + sat.reference_direction * 360 * orbitsElapsed;
  const rawLng = sat.orbit_orientation_deg - 24.5 * orbitsElapsed;

  const wrappedLat = ((((rawLat + 180) % 360) + 360) % 360) - 180;

  let currentLat: number;
  let poleCrossFlip = 0;

  if (wrappedLat > 90) {
    currentLat = 180 - wrappedLat;
    poleCrossFlip = 180;
  } else if (wrappedLat < -90) {
    currentLat = -180 - wrappedLat;
    poleCrossFlip = 180;
  } else {
    currentLat = wrappedLat;
  }

  const currentLng = normalizeLongitude(rawLng + poleCrossFlip);
  return { lat: currentLat, lng: currentLng };
}

export async function getGeoEvents(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const offset = (page - 1) * limit;

    const pool = getPool();

    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM geo_events');
    const total: number = countResult.rows[0]?.total ?? 0;

    const rowsResult = await pool.query(
      `SELECT id, title, latitude, longitude, intensity, created_at
       FROM geo_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const data = rowsResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      intensity: Number(row.intensity),
      created_at: row.created_at,
    }));

    res.status(200).json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching geo_events:', error);
    res.status(500).json({
      error: 'Failed to retrieve geo events',
      details: error?.message,
    });
  }
}

export async function createGeoEvent(req: Request, res: Response): Promise<void> {
  try {
    const { title, latitude, longitude, intensity } = req.body;

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Field "title" is required and must be a string.' });
      return;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const int = intensity !== undefined ? Number(intensity) : 0.75;

    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      res.status(400).json({ error: 'Field "latitude" must be a valid number between -90 and 90.' });
      return;
    }

    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Field "longitude" must be a valid number between -180 and 180.' });
      return;
    }

    if (Number.isNaN(int) || int < 0 || int > 10) {
      res.status(400).json({ error: 'Field "intensity" must be a valid number between 0 and 10.' });
      return;
    }

    const result = await publishGeoEventCreated({
      title: title.trim(),
      latitude: lat,
      longitude: lng,
      intensity: int,
    });

    res.status(202).json({
      status: 'accepted',
      message: 'Geo event published to NATS JetStream (geo.events.created)',
      jetstream: {
        stream: result.stream,
        seq: result.seq,
      },
      event: result.event,
    });
  } catch (error: any) {
    console.error('[Controller] Error publishing geo_event:', error);
    res.status(500).json({
      error: 'Failed to publish geo event to NATS JetStream',
      details: error?.message,
    });
  }
}

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const [dbStatus, natsStatus] = await Promise.all([checkDbHealth(), checkNatsHealth()]);

  const healthy = dbStatus.connected && natsStatus.connected;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      postgresql: dbStatus,
      natsJetStream: natsStatus,
    },
  });
}

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const statsResult = await pool.query(`
      SELECT
        COUNT(*)::int AS total_events,
        AVG(intensity) AS avg_intensity,
        MAX(intensity) AS max_intensity,
        MIN(intensity) AS min_intensity
      FROM geo_events
    `);

    const natsStatus = await checkNatsHealth();
    const row = statsResult.rows[0] || {};

    res.status(200).json({
      timestamp: new Date().toISOString(),
      metrics: {
        totalEvents: row.total_events ?? 0,
        avgIntensity: Number(Number(row.avg_intensity ?? 0).toFixed(3)),
        maxIntensity: Number(row.max_intensity ?? 0),
        minIntensity: Number(row.min_intensity ?? 0),
        jetstreamPublished: natsStatus.publishedCount,
        jetstreamConsumed: natsStatus.consumedCount,
        streamTotalMessages: natsStatus.streamMessages ?? 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to compute metrics',
      details: error?.message,
    });
  }
}

export async function getSatelliteFleet(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const rowsResult = await pool.query(
      `SELECT
         id,
         orbit_altitude_km,
         orbit_orientation_deg,
         reference_latitude_deg,
         reference_direction,
         reference_timestamp,
         status
       FROM satellite_fleet
       ORDER BY orbit_orientation_deg ASC`
    );

    const data = rowsResult.rows.map((row) => ({
      id: row.id,
      orbit_altitude_km: Number(row.orbit_altitude_km),
      orbit_orientation_deg: Number(row.orbit_orientation_deg),
      reference_latitude_deg: Number(row.reference_latitude_deg),
      reference_direction: Number(row.reference_direction) as 1 | -1,
      reference_timestamp:
        row.reference_timestamp instanceof Date
          ? row.reference_timestamp.toISOString()
          : String(row.reference_timestamp),
      status: (String(row.status || 'active').toLowerCase() === 'disabled'
        ? 'disabled'
        : 'active') as 'active' | 'disabled',
    }));

    res.status(200).json({
      data,
      total: data.length,
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching satellite_fleet:', error);
    res.status(500).json({
      error: 'Failed to retrieve satellite fleet configuration',
      details: error?.message,
    });
  }
}

export async function updateSatelliteStatus(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const id = String(req.params.id);
    const rawStatus = String(req.body?.status || '').toLowerCase();

    if (rawStatus !== 'active' && rawStatus !== 'disabled') {
      res.status(400).json({
        error: 'Field "status" must be either "active" or "disabled".',
      });
      return;
    }

    const nextStatus: 'active' | 'disabled' = rawStatus;

    const existingRes = await pool.query(
      `SELECT id FROM satellite_fleet WHERE id = $1`,
      [id]
    );
    if (existingRes.rows.length === 0) {
      res.status(404).json({ error: 'Satellite not found.' });
      return;
    }

    await pool.query(
      `UPDATE satellite_fleet SET status = $1 WHERE id = $2`,
      [nextStatus, id]
    );

    let reprogrammedCount = 0;
    let reassignedCount = 0;

    if (nextStatus === 'disabled') {
      reprogrammedCount = await reprogramPendingAcquisitionsForDisabledSatellite(id);
    } else {
      reassignedCount = await reassignEarlierAcquisitionsToReactivatedSatellite(id);
    }

    const updatedRes = await pool.query(
      `SELECT
         id,
         orbit_altitude_km,
         orbit_orientation_deg,
         reference_latitude_deg,
         reference_direction,
         reference_timestamp,
         status
       FROM satellite_fleet
       WHERE id = $1`,
      [id]
    );

    const row = updatedRes.rows[0];
    const updatedSat = {
      id: String(row.id),
      orbit_altitude_km: Number(row.orbit_altitude_km),
      orbit_orientation_deg: Number(row.orbit_orientation_deg),
      reference_latitude_deg: Number(row.reference_latitude_deg),
      reference_direction: Number(row.reference_direction) as 1 | -1,
      reference_timestamp:
        row.reference_timestamp instanceof Date
          ? row.reference_timestamp.toISOString()
          : String(row.reference_timestamp),
      status: (String(row.status || 'active').toLowerCase() === 'disabled'
        ? 'disabled'
        : 'active') as 'active' | 'disabled',
      reprogrammed_count: reprogrammedCount,
      reassigned_count: reassignedCount,
    };

    await publishSatelliteStatusUpdated(updatedSat);

    res.status(200).json({
      status: 'updated',
      data: updatedSat,
    });
  } catch (error: any) {
    console.error('[Controller] Error updating satellite status:', error);
    res.status(500).json({
      error: 'Failed to update satellite status',
      details: error?.message,
    });
  }
}

export async function getUsers(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT id, name FROM users ORDER BY name ASC');
    res.status(200).json({
      data: result.rows.map((r) => ({ id: r.id, name: r.name })),
      total: result.rows.length,
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching users:', error);
    res.status(500).json({
      error: 'Failed to retrieve users',
      details: error?.message,
    });
  }
}

function mapAcquisitionRow(row: any) {
  return {
    id: row.id,
    satellite_id: row.satellite_id,
    user_id: row.user_id || DEFAULT_SYSTEM_USER_ID,
    acquisition_timestamp:
      row.acquisition_timestamp instanceof Date
        ? row.acquisition_timestamp.toISOString()
        : String(row.acquisition_timestamp),
    duration_seconds: Number(row.duration_seconds),
    center_longitude_deg: Number(row.center_longitude_deg),
    center_latitude_deg: Number(row.center_latitude_deg),
    width_m: Number(row.width_m),
    height_m: Number(row.height_m),
    status: String(row.status),
    acquired_image: row.acquired_image ?? null,
    reprogrammed_from_id: row.reprogrammed_from_id ? String(row.reprogrammed_from_id) : null,
  };
}

export function streamAcquisitionPlanUpdates(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const cleanup = registerAcquisitionSseClient(res);
  req.on('close', () => {
    cleanup();
    res.end();
  });
}

export async function getAcquisitionById(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
         id,
         satellite_id,
         user_id,
         acquisition_timestamp,
         duration_seconds,
         center_longitude_deg,
         center_latitude_deg,
         width_m,
         height_m,
         status,
         acquired_image
       FROM acquisition_plan
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Acquisition plan row not found' });
      return;
    }

    res.status(200).json({
      data: mapAcquisitionRow(result.rows[0]),
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching acquisition_plan row by id:', error);
    res.status(500).json({
      error: 'Failed to retrieve acquisition plan item',
      details: error?.message,
    });
  }
}

export async function getAcquisitionPlan(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const satelliteId = req.query.satellite_id as string | undefined;

    const rowsResult = satelliteId
      ? await pool.query(
          `SELECT
             id,
             satellite_id,
             user_id,
             acquisition_timestamp,
             duration_seconds,
             center_longitude_deg,
             center_latitude_deg,
             width_m,
             height_m,
             status,
             acquired_image
           FROM acquisition_plan
           WHERE satellite_id = $1
           ORDER BY acquisition_timestamp ASC`,
          [satelliteId]
        )
      : await pool.query(
          `SELECT
             id,
             satellite_id,
             user_id,
             acquisition_timestamp,
             duration_seconds,
             center_longitude_deg,
             center_latitude_deg,
             width_m,
             height_m,
             status,
             acquired_image
           FROM acquisition_plan
           ORDER BY acquisition_timestamp ASC`
        );

    const data = rowsResult.rows.map(mapAcquisitionRow);

    res.status(200).json({
      data,
      total: data.length,
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching acquisition_plan:', error);
    res.status(500).json({
      error: 'Failed to retrieve acquisition plan',
      details: error?.message,
    });
  }
}

interface CandidateTarget {
  targetTimeMs: number;
  widthM: number;
  heightM: number;
  centerLatDeg: number;
  centerLngDeg: number;
}

/**
 * Computes a random square target inside the satellite's 300x300 km footprint at targetTimeMs.
 */
function buildTargetAtTime(sat: SatelliteRow, targetTimeMs: number): CandidateTarget {
  // Random square acquisition size between 5 km (5,000 m) and 50 km (50,000 m)
  const sizeMeters = Math.round(5_000 + Math.random() * 45_000);
  const widthM = sizeMeters;
  const heightM = sizeMeters;

  const subpoint = computeSatelliteSubpoint(sat, targetTimeMs);

  // Ensure the widthM x heightM square fits completely inside the 300x300 km coverage footprint
  const maxCenterOffsetM = (COVERAGE_SIZE_METERS - sizeMeters) / 2;
  const offsetNorthM = (Math.random() * 2 - 1) * maxCenterOffsetM;
  const offsetEastM = (Math.random() * 2 - 1) * maxCenterOffsetM;

  const deltaLatDeg = offsetNorthM / METERS_PER_DEG_LAT;
  const halfHeightDeg = heightM / 2 / METERS_PER_DEG_LAT;
  const maxAbsLat = Math.max(0, 89.9 - halfHeightDeg);
  const centerLatDeg = Number(
    Math.max(-maxAbsLat, Math.min(maxAbsLat, subpoint.lat + deltaLatDeg)).toFixed(6)
  );

  const cosLat = Math.max(0.1, Math.cos((centerLatDeg * Math.PI) / 180));
  const metersPerDegLng = METERS_PER_DEG_LAT * cosLat;
  const deltaLngDeg = offsetEastM / metersPerDegLng;
  const centerLngDeg = Number(normalizeLongitude(subpoint.lng + deltaLngDeg).toFixed(6));

  return {
    targetTimeMs,
    widthM,
    heightM,
    centerLatDeg,
    centerLngDeg,
  };
}

/**
 * Samples a timestamp in [minTimeMs, maxTimeMs] where both the satellite subpoint and
 * the target center inside its footprint lie on a landmass.
 */
function sampleLandAcquisitionForSatellite(
  sat: SatelliteRow,
  minTimeMs: number,
  maxTimeMs: number
): CandidateTarget {
  const windowMs = Math.max(1_000, maxTimeMs - minTimeMs);

  // 1. Rejection sampling over random timestamps in [minTimeMs, maxTimeMs]
  for (let attempt = 0; attempt < 300; attempt++) {
    const t = minTimeMs + Math.floor(Math.random() * windowMs);
    const subpoint = computeSatelliteSubpoint(sat, t);
    if (!isPointOnLand(subpoint.lat, subpoint.lng)) {
      continue;
    }
    const candidate = buildTargetAtTime(sat, t);
    if (isPointOnLand(candidate.centerLatDeg, candidate.centerLngDeg)) {
      return candidate;
    }
  }

  // 2. Deterministic scan fallback (5-second steps from a random offset)
  const stepMs = 5_000;
  const steps = Math.max(1, Math.floor(windowMs / stepMs));
  const startStep = Math.floor(Math.random() * steps);
  for (let s = 0; s < steps; s++) {
    const idx = (startStep + s) % steps;
    const t = minTimeMs + idx * stepMs;
    const subpoint = computeSatelliteSubpoint(sat, t);
    if (isPointOnLand(subpoint.lat, subpoint.lng)) {
      for (let k = 0; k < 10; k++) {
        const candidate = buildTargetAtTime(sat, t);
        if (isPointOnLand(candidate.centerLatDeg, candidate.centerLngDeg)) {
          return candidate;
        }
      }
    }
  }

  return buildTargetAtTime(sat, minTimeMs + Math.floor(Math.random() * windowMs));
}

/**
 * Clears existing rows and adds 4 new acquisition plan rows per satellite for the 3 hours
 * following current UTC time (assigned to the "system" user), with the first acquisition
 * occurring 3 minutes after initialization and all acquisitions located on land masses.
 */
export async function initializeAcquisitionPlan(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();

    // Clear existing acquisition plan rows and old request queue before initializing new 3h plan
    clearAllReservationTimers();
    await pool.query('DELETE FROM acquisition_plan');
    await pool.query('DELETE FROM acquisition_requests');
    await broadcastCurrentRequestQueue();

    // Look up the "system" user ID
    const systemUserResult = await pool.query(
      'SELECT id FROM users WHERE name = $1 LIMIT 1',
      ['system']
    );
    const systemUserId: string = systemUserResult.rows[0]?.id || DEFAULT_SYSTEM_USER_ID;

    const fleetResult = await pool.query(
      `SELECT
         id,
         orbit_altitude_km,
         orbit_orientation_deg,
         reference_latitude_deg,
         reference_direction,
         reference_timestamp
       FROM satellite_fleet
       ORDER BY orbit_orientation_deg ASC`
    );

    const satellites: SatelliteRow[] = fleetResult.rows.map((row) => ({
      id: row.id,
      orbit_altitude_km: Number(row.orbit_altitude_km),
      orbit_orientation_deg: Number(row.orbit_orientation_deg),
      reference_latitude_deg: Number(row.reference_latitude_deg),
      reference_direction: Number(row.reference_direction) as 1 | -1,
      reference_timestamp:
        row.reference_timestamp instanceof Date
          ? row.reference_timestamp.toISOString()
          : String(row.reference_timestamp),
    }));

    const nowMs = Date.now();
    const firstAcquisitionTimeMs = nowMs + 30 * 1000; // First acquisition 30 seconds after initialization
    const maxAcquisitionTimeMs = firstAcquisitionTimeMs + 30 * 60 * 1000; // Rest within a 30-minute period after first acquisition
    const durationSeconds = 20; // 20-second acquisition duration
    let addedCount = 0;

    // Select a satellite that is passing over a landmass at T = now + 2 minutes for the very first acquisition
    const shuffledSatellites = [...satellites].sort(() => Math.random() - 0.5);
    let firstSatId: string | null = null;
    let firstSatTarget: CandidateTarget | null = null;

    // Pass 1: Satellite subpoint AND target both on land at exact T = now + 2 minutes
    for (const sat of shuffledSatellites) {
      const subpoint = computeSatelliteSubpoint(sat, firstAcquisitionTimeMs);
      if (!isPointOnLand(subpoint.lat, subpoint.lng)) continue;
      for (let k = 0; k < 25; k++) {
        const candidate = buildTargetAtTime(sat, firstAcquisitionTimeMs);
        if (isPointOnLand(candidate.centerLatDeg, candidate.centerLngDeg)) {
          firstSatId = sat.id;
          firstSatTarget = candidate;
          break;
        }
      }
      if (firstSatTarget) break;
    }

    // Pass 2: Any target within a satellite's 300x300 km footprint on land at exact T = now + 2 minutes
    if (!firstSatTarget) {
      for (const sat of shuffledSatellites) {
        for (let k = 0; k < 40; k++) {
          const candidate = buildTargetAtTime(sat, firstAcquisitionTimeMs);
          if (isPointOnLand(candidate.centerLatDeg, candidate.centerLngDeg)) {
            firstSatId = sat.id;
            firstSatTarget = candidate;
            break;
          }
        }
        if (firstSatTarget) break;
      }
    }

    for (const sat of satellites) {
      for (let i = 0; i < 4; i++) {
        const id = crypto.randomUUID();

        const target: CandidateTarget =
          sat.id === firstSatId && i === 0 && firstSatTarget
            ? firstSatTarget
            : sampleLandAcquisitionForSatellite(
                sat,
                firstAcquisitionTimeMs + 5_000,
                maxAcquisitionTimeMs
              );

        const acquisitionTimestampIso = new Date(target.targetTimeMs).toISOString();

        await pool.query(
          `INSERT INTO acquisition_plan (
             id,
             satellite_id,
             user_id,
             acquisition_timestamp,
             duration_seconds,
             center_longitude_deg,
             center_latitude_deg,
             width_m,
             height_m,
             status,
             acquired_image
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            sat.id,
            systemUserId,
            acquisitionTimestampIso,
            durationSeconds,
            target.centerLngDeg,
            target.centerLatDeg,
            target.widthM,
            target.heightM,
            'Pending',
            null,
          ]
        );
        addedCount++;
      }
    }

    // Automatically start the background acquisition plan executor process
    startAcquisitionPlanExecutor();

    const planResult = await pool.query(
      `SELECT
         id,
         satellite_id,
         user_id,
         acquisition_timestamp,
         duration_seconds,
         center_longitude_deg,
         center_latitude_deg,
         width_m,
         height_m,
         status,
         acquired_image
       FROM acquisition_plan
       ORDER BY acquisition_timestamp ASC`
    );

    const data = planResult.rows.map(mapAcquisitionRow);

    res.status(200).json({
      data,
      added: addedCount,
      total: data.length,
    });
  } catch (error: any) {
    console.error('[Controller] Error initializing acquisition_plan:', error);
    res.status(500).json({
      error: 'Failed to initialize acquisition plan',
      details: error?.message,
    });
  }
}

/**
 * Enqueues a new image acquisition request with a timestamp (`created_at`) and triggers
 * the FIFO background request evaluator.
 */
export async function submitAcquisitionRequest(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const {
      longitude,
      latitude,
      width_m,
      height_m,
      time_mode,
      requested_timestamp,
      confirmation_mode,
      reprogrammed_from_id,
      user_id,
    } = req.body;

    const lng = Number(longitude);
    const lat = Number(latitude);
    const widthM = Number(width_m);
    const heightM = Number(height_m);
    const mode = String(time_mode || 'ASAP').toUpperCase() === 'ABSOLUTE' ? 'ABSOLUTE' : 'ASAP';
    const confirmMode: 'manual' | 'auto' =
      String(confirmation_mode || 'manual').toLowerCase() === 'auto' ? 'auto' : 'manual';
    const reprogrammedFromId: string | null =
      typeof reprogrammed_from_id === 'string' && reprogrammed_from_id.trim()
        ? reprogrammed_from_id.trim()
        : null;

    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      res.status(400).json({ error: 'Field "latitude" must be between -90 and 90.' });
      return;
    }

    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Field "longitude" must be between -180 and 180.' });
      return;
    }

    if (Number.isNaN(widthM) || widthM <= 0 || Number.isNaN(heightM) || heightM <= 0) {
      res.status(400).json({ error: 'Fields "width_m" and "height_m" must be positive numbers.' });
      return;
    }

    let parsedRequestedIso: string | null = null;
    if (mode === 'ABSOLUTE') {
      if (!requested_timestamp) {
        res.status(400).json({ error: 'Field "requested_timestamp" is required for ABSOLUTE time mode.' });
        return;
      }
      const parsedMs = new Date(requested_timestamp).getTime();
      if (Number.isNaN(parsedMs)) {
        res.status(400).json({ error: 'Field "requested_timestamp" is not a valid date/time.' });
        return;
      }
      parsedRequestedIso = new Date(parsedMs).toISOString();
    }

    // Default to the "demo" user when submitted from the web app
    let resolvedUserId = typeof user_id === 'string' && user_id.trim() ? user_id.trim() : '';
    if (!resolvedUserId) {
      const demoUserRes = await pool.query('SELECT id FROM users WHERE name = $1 LIMIT 1', [
        'demo',
      ]);
      resolvedUserId = demoUserRes.rows[0]?.id || DEFAULT_DEMO_USER_ID;
    }

    const requestId = crypto.randomUUID();
    const createdAtIso = new Date().toISOString();

    await pool.query(
      `INSERT INTO acquisition_requests (
         id,
         user_id,
         center_longitude_deg,
         center_latitude_deg,
         width_m,
         height_m,
         time_mode,
         requested_timestamp,
         confirmation_mode,
         reprogrammed_from_id,
         created_at,
         status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        requestId,
        resolvedUserId,
        lng,
        lat,
        widthM,
        heightM,
        mode,
        parsedRequestedIso,
        confirmMode,
        reprogrammedFromId,
        createdAtIso,
        'Queued',
      ]
    );

    // Broadcast updated queue to connected clients & trigger FIFO queue processor asynchronously
    await broadcastCurrentRequestQueue();
    triggerRequestQueueProcessor();

    res.status(202).json({
      status: 'queued',
      request: {
        id: requestId,
        user_id: resolvedUserId,
        center_longitude_deg: lng,
        center_latitude_deg: lat,
        width_m: widthM,
        height_m: heightM,
        time_mode: mode,
        requested_timestamp: parsedRequestedIso,
        confirmation_mode: confirmMode,
        reprogrammed_from_id: reprogrammedFromId,
        created_at: createdAtIso,
        status: 'Queued',
      },
    });
  } catch (error: any) {
    console.error('[Controller] Error submitting acquisition request:', error);
    res.status(500).json({
      error: 'Failed to enqueue acquisition request',
      details: error?.message,
    });
  }
}

/**
 * Returns the active queue of pending acquisition requests (`Queued` and `Evaluating`),
 * ordered chronologically by `created_at ASC`.
 */
export async function getAcquisitionRequestsQueue(_req: Request, res: Response): Promise<void> {
  try {
    const queue = await fetchCurrentRequestQueue();
    res.status(200).json({
      data: queue,
      total: queue.length,
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching acquisition_requests queue:', error);
    res.status(500).json({
      error: 'Failed to retrieve acquisition requests queue',
      details: error?.message,
    });
  }
}

/**
 * Confirms a 'Reserved' acquisition entry in acquisition_plan, transitioning its status to 'Pending'
 * and activating it in the background acquisition executor.
 */
export async function confirmReservedAcquisition(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const id = String(req.params.id);

    clearReservationTimer(id);

    const existingRes = await pool.query(
      `SELECT
         id,
         satellite_id,
         user_id,
         acquisition_timestamp,
         duration_seconds,
         center_longitude_deg,
         center_latitude_deg,
         width_m,
         height_m,
         status,
         acquired_image,
         reprogrammed_from_id
       FROM acquisition_plan
       WHERE id = $1`,
      [id]
    );

    if (existingRes.rows.length === 0) {
      res.status(404).json({
        error: 'Reserved acquisition not found or has already expired.',
      });
      return;
    }

    await pool.query(
      `UPDATE acquisition_plan SET status = 'Pending' WHERE id = $1`,
      [id]
    );

    const reprogrammedFromId = existingRes.rows[0].reprogrammed_from_id
      ? String(existingRes.rows[0].reprogrammed_from_id)
      : null;
    await markOriginalAcquisitionAsReprogrammed(reprogrammedFromId);

    const updatedRow = mapAcquisitionRow({
      ...existingRes.rows[0],
      status: 'Pending',
    });

    await publishAcquisitionUpdated(updatedRow);
    startAcquisitionPlanExecutor();

    res.status(200).json({
      status: 'confirmed',
      data: updatedRow,
    });
  } catch (error: any) {
    console.error('[Controller] Error confirming reserved acquisition:', error);
    res.status(500).json({
      error: 'Failed to confirm reserved acquisition',
      details: error?.message,
    });
  }
}

/**
 * Marks an acquisition entry in acquisition_plan as 'Failed' (clearing its acquired_image)
 * and broadcasts the update via NATS JetStream + SSE.
 */
export async function markAcquisitionAsFailed(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const id = String(req.params.id);

    const existingRes = await pool.query(
      `SELECT
         id,
         satellite_id,
         user_id,
         acquisition_timestamp,
         duration_seconds,
         center_longitude_deg,
         center_latitude_deg,
         width_m,
         height_m,
         status,
         acquired_image,
         reprogrammed_from_id
       FROM acquisition_plan
       WHERE id = $1`,
      [id]
    );

    if (existingRes.rows.length === 0) {
      res.status(404).json({
        error: 'Acquisition plan row not found.',
      });
      return;
    }

    await pool.query(
      `UPDATE acquisition_plan
       SET status = 'Failed', acquired_image = NULL
       WHERE id = $1`,
      [id]
    );

    const updatedRow = mapAcquisitionRow({
      ...existingRes.rows[0],
      status: 'Failed',
      acquired_image: null,
    });

    await publishAcquisitionUpdated(updatedRow);

    res.status(200).json({
      status: 'failed',
      data: updatedRow,
    });
  } catch (error: any) {
    console.error('[Controller] Error marking acquisition as failed:', error);
    res.status(500).json({
      error: 'Failed to mark acquisition as failed',
      details: error?.message,
    });
  }
}

/**
 * Cancels a 'Reserved' acquisition entry and removes it from acquisition_plan.
 */
export async function cancelReservedAcquisition(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const id = String(req.params.id);

    clearReservationTimer(id);

    const existingRes = await pool.query(
      `SELECT id, satellite_id, acquisition_timestamp, status
       FROM acquisition_plan
       WHERE id = $1`,
      [id]
    );

    if (existingRes.rows.length === 0) {
      res.status(200).json({
        status: 'canceled',
        acquisition_id: id,
      });
      return;
    }

    const row = existingRes.rows[0];
    const satId = String(row.satellite_id);
    const acqIso =
      row.acquisition_timestamp instanceof Date
        ? row.acquisition_timestamp.toISOString()
        : String(row.acquisition_timestamp);

    await pool.query(
      `DELETE FROM acquisition_plan WHERE id = $1 AND status = 'Reserved'`,
      [id]
    );

    await publishAcquisitionCanceled({
      acquisition_id: id,
      satellite_id: satId,
      acquisition_timestamp: acqIso,
      reason: 'user_canceled',
      message: 'Reservation was canceled by the user.',
    });

    res.status(200).json({
      status: 'canceled',
      acquisition_id: id,
    });
  } catch (error: any) {
    console.error('[Controller] Error canceling reserved acquisition:', error);
    res.status(500).json({
      error: 'Failed to cancel reserved acquisition',
      details: error?.message,
    });
  }
}
