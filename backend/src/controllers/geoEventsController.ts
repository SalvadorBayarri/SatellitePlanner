import crypto from 'crypto';
import { Request, Response } from 'express';
import { getPool, checkDbHealth } from '../db';
import { publishGeoEventCreated, checkNatsHealth } from '../events/nats';
import { startAcquisitionPlanExecutor } from '../services/acquisitionExecutor';

const ORBIT_PERIOD_MINUTES = 97;
const COVERAGE_SIZE_METERS = 300_000; // 300 km x 300 km satellite footprint
const METERS_PER_DEG_LAT = 111_320;

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
         reference_timestamp
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

function mapAcquisitionRow(row: any) {
  return {
    id: row.id,
    satellite_id: row.satellite_id,
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
  };
}

export async function getAcquisitionById(req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
         id,
         satellite_id,
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

/**
 * Clears existing rows and adds 4 new acquisition plan rows per satellite for the 3 hours
 * following current UTC time, then returns the complete acquisition plan.
 */
export async function initializeAcquisitionPlan(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();

    // Clear existing acquisition plan rows before initializing new 3h plan
    await pool.query('DELETE FROM acquisition_plan');

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
    const threeHoursMs = 3 * 60 * 60 * 1000;
    const durationSeconds = 60; // Constant 1 minute acquisition interval for the prototype
    let addedCount = 0;

    for (const sat of satellites) {
      for (let i = 0; i < 4; i++) {
        const id = crypto.randomUUID();
        // Random acquisition timestamp within the next 3 hours
        const targetTimeMs = nowMs + Math.floor(Math.random() * threeHoursMs);
        const acquisitionTimestampIso = new Date(targetTimeMs).toISOString();

        // Random square acquisition size between 5 km (5,000 m) and 50 km (50,000 m)
        const sizeMeters = Math.round(5_000 + Math.random() * 45_000);
        const widthM = sizeMeters;
        const heightM = sizeMeters;

        // Compute satellite sub-point at the planned acquisition time
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

        await pool.query(
          `INSERT INTO acquisition_plan (
             id,
             satellite_id,
             acquisition_timestamp,
             duration_seconds,
             center_longitude_deg,
             center_latitude_deg,
             width_m,
             height_m,
             status,
             acquired_image
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            sat.id,
            acquisitionTimestampIso,
            durationSeconds,
            centerLngDeg,
            centerLatDeg,
            widthM,
            heightM,
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
