import crypto from 'crypto';
import { getPool } from '../db';
import {
  AcquisitionPlanUpdatePayload,
  publishAcquisitionUpdated,
  publishAcquisitionRequestEvaluated,
  publishAcquisitionCanceled,
} from '../events/nats';

const ORBIT_PERIOD_MINUTES = 97;
const COVERAGE_SIZE_METERS = 300_000; // 300 km x 300 km satellite capture footprint
const METERS_PER_DEG_LAT = 111_320;
const ACQUISITION_DURATION_SECONDS = 20;
const REQUEST_PROCESSING_DELAY_MS = 10_000; // 10-second simulated evaluation delay for demo purposes
const RESERVATION_CONFIRM_TIMEOUT_MS = 60_000; // 1-minute confirmation window before auto-cancel
const DEFAULT_DEMO_USER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02';

const reservationExpirationTimers = new Map<string, NodeJS.Timeout>();

export function clearReservationTimer(acquisitionId: string): void {
  const timer = reservationExpirationTimers.get(acquisitionId);
  if (timer) {
    clearTimeout(timer);
    reservationExpirationTimers.delete(acquisitionId);
  }
}

export function clearAllReservationTimers(): void {
  for (const timer of reservationExpirationTimers.values()) {
    clearTimeout(timer);
  }
  reservationExpirationTimers.clear();
}

function scheduleReservationExpirationTimer(
  acquisitionId: string,
  requestId: string,
  satelliteId: string,
  feasibleTimeMs: number
): void {
  clearReservationTimer(acquisitionId);

  const nowMs = Date.now();
  const oneMinuteDeadlineMs = nowMs + RESERVATION_CONFIRM_TIMEOUT_MS;
  const acquisitionTimeDeadlineMs = feasibleTimeMs;
  const expireAtMs = Math.min(oneMinuteDeadlineMs, acquisitionTimeDeadlineMs);
  const delayMs = Math.max(0, expireAtMs - nowMs);
  const reason: 'timeout' | 'acquisition_time_reached' =
    acquisitionTimeDeadlineMs <= oneMinuteDeadlineMs ? 'acquisition_time_reached' : 'timeout';

  const timer = setTimeout(async () => {
    reservationExpirationTimers.delete(acquisitionId);
    try {
      const pool = getPool();
      const checkRes = await pool.query(
        `SELECT id, status FROM acquisition_plan WHERE id = $1`,
        [acquisitionId]
      );
      if (checkRes.rows.length === 0 || String(checkRes.rows[0].status) !== 'Reserved') {
        return;
      }

      // Remove the unconfirmed Reserved acquisition from the plan
      await pool.query(
        `DELETE FROM acquisition_plan WHERE id = $1 AND status = 'Reserved'`,
        [acquisitionId]
      );
      await pool.query(
        `UPDATE acquisition_requests SET status = 'Canceled' WHERE id = $1`,
        [requestId]
      );

      const feasibleIso = new Date(feasibleTimeMs).toISOString();
      const shortSat = satelliteId.slice(-4).toUpperCase();
      const message =
        reason === 'acquisition_time_reached'
          ? `Reservation on SAT-${shortSat} was automatically canceled because the planned capture time (${feasibleIso.replace('T', ' ').slice(0, 19)} UTC) was reached before confirmation.`
          : `Reservation on SAT-${shortSat} was automatically canceled because confirmation was not received within 1 minute.`;

      console.log(
        `[RequestQueue] Auto-canceled unconfirmed Reserved acquisition ${acquisitionId} (reason=${reason})`
      );

      await publishAcquisitionCanceled({
        acquisition_id: acquisitionId,
        request_id: requestId,
        satellite_id: satelliteId,
        acquisition_timestamp: feasibleIso,
        reason,
        message,
      });
    } catch (err) {
      console.error('[RequestQueue] Error auto-canceling expired reservation:', err);
    }
  }, delayMs);

  reservationExpirationTimers.set(acquisitionId, timer);
}

interface SatelliteRow {
  id: string;
  orbit_altitude_km: number;
  orbit_orientation_deg: number;
  reference_latitude_deg: number;
  reference_direction: 1 | -1;
  reference_timestamp: string;
}

interface ExistingCommitment {
  id: string;
  satellite_id: string;
  timestampMs: number;
  durationSeconds: number;
}

interface QueuedRequestRow {
  id: string;
  user_id: string;
  center_longitude_deg: number;
  center_latitude_deg: number;
  width_m: number;
  height_m: number;
  time_mode: 'ASAP' | 'ABSOLUTE';
  requested_timestamp: string | null;
  created_at: string;
  status: string;
}

function normalizeLongitude(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

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

/**
 * Checks if a satellite has any overlapping acquisition commitment at candidateTimeMs.
 */
function hasTimeWindowConflict(
  satId: string,
  candidateTimeMs: number,
  durationSeconds: number,
  commitmentsBySat: Map<string, ExistingCommitment[]>
): boolean {
  const list = commitmentsBySat.get(satId);
  if (!list || list.length === 0) return false;

  for (const c of list) {
    const minSeparationMs = ((durationSeconds + c.durationSeconds) / 2) * 1000;
    if (Math.abs(candidateTimeMs - c.timestampMs) < minSeparationMs) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether the satellite's 300x300 km footprint at candidateTimeMs completely covers
 * the requested widthM x heightM square centered at (targetLat, targetLng).
 * Returns { covered, offNadirMeters }.
 */
function checkFootprintCoverage(
  sat: SatelliteRow,
  candidateTimeMs: number,
  targetLat: number,
  targetLng: number,
  widthM: number,
  heightM: number
): { covered: boolean; offNadirMeters: number } {
  const subpoint = computeSatelliteSubpoint(sat, candidateTimeMs);

  const maxNorthOffsetM = Math.max(0, (COVERAGE_SIZE_METERS - heightM) / 2);
  const maxEastOffsetM = Math.max(0, (COVERAGE_SIZE_METERS - widthM) / 2);

  const distNorthM = Math.abs(targetLat - subpoint.lat) * METERS_PER_DEG_LAT;
  if (distNorthM > maxNorthOffsetM) {
    const cosLatApprox = Math.max(0.1, Math.cos((targetLat * Math.PI) / 180));
    const distEastApprox =
      Math.abs(normalizeLongitude(targetLng - subpoint.lng)) * METERS_PER_DEG_LAT * cosLatApprox;
    return {
      covered: false,
      offNadirMeters: Math.hypot(distNorthM, distEastApprox),
    };
  }

  const cosLat = Math.max(0.1, Math.cos((targetLat * Math.PI) / 180));
  const deltaLng = Math.abs(normalizeLongitude(targetLng - subpoint.lng));
  const distEastM = deltaLng * METERS_PER_DEG_LAT * cosLat;

  const covered = distEastM <= maxEastOffsetM;
  const offNadirMeters = Math.hypot(distNorthM, distEastM);

  return { covered, offNadirMeters };
}

/**
 * Computes a fake cost estimation in arbitrary point units based on capture area,
 * scheduling mode (ASAP vs. Absolute), and off-nadir slew distance.
 */
function computeEstimatedCostPoints(
  widthM: number,
  heightM: number,
  timeMode: 'ASAP' | 'ABSOLUTE',
  offNadirMeters: number
): number {
  const areaSqKm = (widthM / 1000) * (heightM / 1000);
  const baseFee = 150;
  const areaPoints = Math.round(areaSqKm * 0.48);
  const priorityPoints = timeMode === 'ASAP' ? 120 : 75;
  const slewPoints = Math.min(180, Math.round((offNadirMeters / 1000) * 0.75));
  return baseFee + areaPoints + priorityPoints + slewPoints;
}

interface FeasibilityMatch {
  satelliteId: string;
  feasibleTimeMs: number;
  fulfilledAsRequested: boolean;
  offNadirMeters: number;
}

/**
 * Evaluates orbital passes across all satellites to find either:
 * - For ASAP: the earliest available conflict-free satellite pass covering the target area.
 * - For ABSOLUTE: any available conflict-free satellite covering the target area at requestedTimeMs,
 *   or if not feasible, the closest possible conflict-free pass in time.
 */
function evaluateRequestFeasibility(
  req: QueuedRequestRow,
  satellites: SatelliteRow[],
  commitmentsBySat: Map<string, ExistingCommitment[]>
): FeasibilityMatch {
  const nowMs = Date.now();
  const minFutureMs = nowMs + 15_000; // Ensure at least 15s in the future
  const maxHorizonMs = 24 * 60 * 60 * 1000; // 24-hour orbital search horizon
  const stepMs = 5_000; // 5-second orbital step

  const targetLat = req.center_latitude_deg;
  const targetLng = req.center_longitude_deg;
  const widthM = req.width_m;
  const heightM = req.height_m;

  if (req.time_mode === 'ASAP' || !req.requested_timestamp) {
    for (let t = minFutureMs; t <= minFutureMs + maxHorizonMs; t += stepMs) {
      for (const sat of satellites) {
        const cov = checkFootprintCoverage(sat, t, targetLat, targetLng, widthM, heightM);
        if (!cov.covered) continue;
        if (hasTimeWindowConflict(sat.id, t, ACQUISITION_DURATION_SECONDS, commitmentsBySat)) {
          continue;
        }

        // Refine within the upcoming 25 seconds of this pass to minimize off-nadir distance
        let bestTimeMs = t;
        let bestOffNadir = cov.offNadirMeters;
        for (let fineT = t; fineT <= t + 25_000; fineT += 1_000) {
          const fineCov = checkFootprintCoverage(sat, fineT, targetLat, targetLng, widthM, heightM);
          if (
            fineCov.covered &&
            !hasTimeWindowConflict(sat.id, fineT, ACQUISITION_DURATION_SECONDS, commitmentsBySat) &&
            fineCov.offNadirMeters < bestOffNadir
          ) {
            bestOffNadir = fineCov.offNadirMeters;
            bestTimeMs = fineT;
          }
        }

        return {
          satelliteId: sat.id,
          feasibleTimeMs: bestTimeMs,
          fulfilledAsRequested: true,
          offNadirMeters: bestOffNadir,
        };
      }
    }
  } else {
    const requestedMs = new Date(req.requested_timestamp).getTime();
    const effectiveReqMs = Math.max(minFutureMs, requestedMs);

    // 1. Check if the requested time itself (within its ±10s capture window) is feasible
    if (requestedMs >= nowMs) {
      let bestDirectSat: SatelliteRow | null = null;
      let bestDirectTimeMs = effectiveReqMs;
      let bestDirectOffNadir = Infinity;

      for (let dt = -10_000; dt <= 10_000; dt += 2_000) {
        const candidateT = requestedMs + dt;
        if (candidateT < nowMs + 5_000) continue;

        for (const sat of satellites) {
          const cov = checkFootprintCoverage(sat, candidateT, targetLat, targetLng, widthM, heightM);
          if (!cov.covered) continue;
          if (
            hasTimeWindowConflict(sat.id, candidateT, ACQUISITION_DURATION_SECONDS, commitmentsBySat)
          ) {
            continue;
          }
          if (cov.offNadirMeters < bestDirectOffNadir) {
            bestDirectOffNadir = cov.offNadirMeters;
            bestDirectSat = sat;
            bestDirectTimeMs = candidateT;
          }
        }
      }

      if (bestDirectSat) {
        return {
          satelliteId: bestDirectSat.id,
          feasibleTimeMs: bestDirectTimeMs,
          fulfilledAsRequested: true,
          offNadirMeters: bestDirectOffNadir,
        };
      }
    }

    // 2. Requested time is not feasible: search outward (requestedMs ± delta) for the closest possible time
    for (let delta = stepMs; delta <= maxHorizonMs; delta += stepMs) {
      const candidates: number[] = [];
      if (requestedMs - delta >= minFutureMs) {
        candidates.push(requestedMs - delta);
      }
      candidates.push(Math.max(minFutureMs, requestedMs + delta));

      for (const candidateT of candidates) {
        for (const sat of satellites) {
          const cov = checkFootprintCoverage(sat, candidateT, targetLat, targetLng, widthM, heightM);
          if (!cov.covered) continue;
          if (
            hasTimeWindowConflict(sat.id, candidateT, ACQUISITION_DURATION_SECONDS, commitmentsBySat)
          ) {
            continue;
          }

          // Refine within ±15s to center the pass while keeping closest to requestedMs
          let bestTimeMs = candidateT;
          let bestOffNadir = cov.offNadirMeters;
          for (let fineT = Math.max(minFutureMs, candidateT - 10_000); fineT <= candidateT + 15_000; fineT += 1_000) {
            const fineCov = checkFootprintCoverage(
              sat,
              fineT,
              targetLat,
              targetLng,
              widthM,
              heightM
            );
            if (
              fineCov.covered &&
              !hasTimeWindowConflict(sat.id, fineT, ACQUISITION_DURATION_SECONDS, commitmentsBySat) &&
              fineCov.offNadirMeters < bestOffNadir
            ) {
              bestOffNadir = fineCov.offNadirMeters;
              bestTimeMs = fineT;
            }
          }

          return {
            satelliteId: sat.id,
            feasibleTimeMs: bestTimeMs,
            fulfilledAsRequested: false,
            offNadirMeters: bestOffNadir,
          };
        }
      }
    }
  }

  // Fallback: pick the satellite & time within the next 2 hours with minimum distance to the target
  let fallbackSat = satellites[0];
  let fallbackTimeMs = minFutureMs + 60_000;
  let minDistance = Infinity;
  for (let t = minFutureMs; t <= minFutureMs + 2 * 3600 * 1000; t += 15_000) {
    for (const sat of satellites) {
      const cov = checkFootprintCoverage(sat, t, targetLat, targetLng, widthM, heightM);
      if (
        cov.offNadirMeters < minDistance &&
        !hasTimeWindowConflict(sat.id, t, ACQUISITION_DURATION_SECONDS, commitmentsBySat)
      ) {
        minDistance = cov.offNadirMeters;
        fallbackSat = sat;
        fallbackTimeMs = t;
      }
    }
  }

  return {
    satelliteId: fallbackSat.id,
    feasibleTimeMs: fallbackTimeMs,
    fulfilledAsRequested: req.time_mode === 'ASAP',
    offNadirMeters: minDistance,
  };
}

let isProcessingQueue = false;

/**
 * Triggers the background FIFO processor that takes the oldest 'Queued' request,
 * evaluates orbital feasibility, inserts a 'Reserved' row into acquisition_plan,
 * and pushes the evaluation result to the frontend via NATS JetStream + SSE.
 */
export function triggerRequestQueueProcessor(): void {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  setImmediate(() => {
    void processQueueLoop();
  });
}

async function processQueueLoop(): Promise<void> {
  try {
    const pool = getPool();

    while (true) {
      // 1. Fetch the oldest queued request by created_at timestamp
      const nextReqResult = await pool.query(
        `SELECT
           id,
           user_id,
           center_longitude_deg,
           center_latitude_deg,
           width_m,
           height_m,
           time_mode,
           requested_timestamp,
           created_at,
           status
         FROM acquisition_requests
         WHERE status = 'Queued'
         ORDER BY created_at ASC
         LIMIT 1`
      );

      if (nextReqResult.rows.length === 0) {
        break;
      }

      const rawReq = nextReqResult.rows[0];
      const reqRow: QueuedRequestRow = {
        id: rawReq.id,
        user_id: rawReq.user_id || DEFAULT_DEMO_USER_ID,
        center_longitude_deg: Number(rawReq.center_longitude_deg),
        center_latitude_deg: Number(rawReq.center_latitude_deg),
        width_m: Number(rawReq.width_m),
        height_m: Number(rawReq.height_m),
        time_mode: (String(rawReq.time_mode).toUpperCase() === 'ABSOLUTE'
          ? 'ABSOLUTE'
          : 'ASAP') as 'ASAP' | 'ABSOLUTE',
        requested_timestamp: rawReq.requested_timestamp
          ? rawReq.requested_timestamp instanceof Date
            ? rawReq.requested_timestamp.toISOString()
            : String(rawReq.requested_timestamp)
          : null,
        created_at:
          rawReq.created_at instanceof Date
            ? rawReq.created_at.toISOString()
            : String(rawReq.created_at),
        status: String(rawReq.status),
      };

      await pool.query(`UPDATE acquisition_requests SET status = 'Evaluating' WHERE id = $1`, [
        reqRow.id,
      ]);

      console.log(
        `[RequestQueue] Processing request ${reqRow.id} (simulating ${REQUEST_PROCESSING_DELAY_MS / 1000}s orbital evaluation)...`
      );
      await new Promise((resolve) => setTimeout(resolve, REQUEST_PROCESSING_DELAY_MS));

      // 2. Load satellite fleet and existing active commitments
      const [fleetResult, commitmentsResult] = await Promise.all([
        pool.query(
          `SELECT
             id,
             orbit_altitude_km,
             orbit_orientation_deg,
             reference_latitude_deg,
             reference_direction,
             reference_timestamp
           FROM satellite_fleet
           ORDER BY orbit_orientation_deg ASC`
        ),
        pool.query(
          `SELECT id, satellite_id, acquisition_timestamp, duration_seconds
           FROM acquisition_plan
           WHERE status IN ('Pending', 'Acquiring', 'Reserved')`
        ),
      ]);

      const satellites: SatelliteRow[] = fleetResult.rows.map((r) => ({
        id: r.id,
        orbit_altitude_km: Number(r.orbit_altitude_km),
        orbit_orientation_deg: Number(r.orbit_orientation_deg),
        reference_latitude_deg: Number(r.reference_latitude_deg),
        reference_direction: Number(r.reference_direction) as 1 | -1,
        reference_timestamp:
          r.reference_timestamp instanceof Date
            ? r.reference_timestamp.toISOString()
            : String(r.reference_timestamp),
      }));

      const commitmentsBySat = new Map<string, ExistingCommitment[]>();
      for (const c of commitmentsResult.rows) {
        const satId = String(c.satellite_id);
        const list = commitmentsBySat.get(satId) || [];
        list.push({
          id: String(c.id),
          satellite_id: satId,
          timestampMs: new Date(c.acquisition_timestamp).getTime(),
          durationSeconds: Number(c.duration_seconds) || ACQUISITION_DURATION_SECONDS,
        });
        commitmentsBySat.set(satId, list);
      }

      // 3. Evaluate feasibility & find satellite + time
      const match = evaluateRequestFeasibility(reqRow, satellites, commitmentsBySat);
      const feasibleIso = new Date(match.feasibleTimeMs).toISOString();
      const estimatedCostPoints = computeEstimatedCostPoints(
        reqRow.width_m,
        reqRow.height_m,
        reqRow.time_mode,
        match.offNadirMeters
      );

      // 4. Create the 'Reserved' row in acquisition_plan
      const reservedAcquisitionId = crypto.randomUUID();
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
          reservedAcquisitionId,
          match.satelliteId,
          reqRow.user_id,
          feasibleIso,
          ACQUISITION_DURATION_SECONDS,
          reqRow.center_longitude_deg,
          reqRow.center_latitude_deg,
          reqRow.width_m,
          reqRow.height_m,
          'Reserved',
          null,
        ]
      );

      await pool.query(`UPDATE acquisition_requests SET status = 'Evaluated' WHERE id = $1`, [
        reqRow.id,
      ]);

      const reservedPayload: AcquisitionPlanUpdatePayload = {
        id: reservedAcquisitionId,
        satellite_id: match.satelliteId,
        user_id: reqRow.user_id,
        acquisition_timestamp: feasibleIso,
        duration_seconds: ACQUISITION_DURATION_SECONDS,
        center_longitude_deg: reqRow.center_longitude_deg,
        center_latitude_deg: reqRow.center_latitude_deg,
        width_m: reqRow.width_m,
        height_m: reqRow.height_m,
        status: 'Reserved',
        acquired_image: null,
      };

      console.log(
        `[RequestQueue] Evaluated request ${reqRow.id} (${reqRow.time_mode}) -> SAT=${match.satelliteId}, time=${feasibleIso}, fulfilledAsRequested=${match.fulfilledAsRequested}, cost=${estimatedCostPoints} pts`
      );

      // Schedule automatic expiration if not confirmed within 1 minute or before acquisition_timestamp
      scheduleReservationExpirationTimer(
        reservedAcquisitionId,
        reqRow.id,
        match.satelliteId,
        match.feasibleTimeMs
      );

      // 5. Notify connected clients of both the new Reserved row and the Evaluation Result popup
      await publishAcquisitionUpdated(reservedPayload);
      await publishAcquisitionRequestEvaluated({
        request_id: reqRow.id,
        queued_at: reqRow.created_at,
        evaluated_at: new Date().toISOString(),
        time_mode: reqRow.time_mode,
        requested_timestamp: reqRow.requested_timestamp,
        fulfilled_as_requested: match.fulfilledAsRequested,
        feasible_timestamp: feasibleIso,
        estimated_cost_points: estimatedCostPoints,
        acquisition: reservedPayload,
      });
    }
  } catch (err) {
    console.error('[RequestQueue] Error while processing acquisition request queue:', err);
  } finally {
    isProcessingQueue = false;
  }
}
