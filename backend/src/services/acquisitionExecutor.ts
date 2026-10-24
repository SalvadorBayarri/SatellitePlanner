import { getPool } from '../db';
import { publishAcquisitionUpdated } from '../events/nats';

const DEFAULT_SYSTEM_USER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01';

let schedulerTimeout: NodeJS.Timeout | null = null;
let currentGeneration = 0;

/**
 * Computes Web Mercator slippy tile coordinates (x, y, z) for a given (lat, lng) and target width in meters,
 * then fetches a 256x256 satellite image from Google Maps Satellite (with Esri World Imagery bbox export fallback)
 * and returns it as a base64 data URI so the 256x256 image is stored directly in the database row.
 */
async function fetchSatelliteImage256(
  lat: number,
  lng: number,
  widthM: number,
  heightM: number
): Promise<string> {
  const clampedLat = Math.max(-85.0, Math.min(85.0, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const cosLat = Math.max(0.1, Math.cos(latRad));

  // Compute zoom level z where a 256x256 tile best matches widthM
  const earthCircumferenceM = 40_075_016.686;
  const idealZ = Math.log2((earthCircumferenceM * cosLat) / Math.max(1000, widthM));
  const z = Math.max(6, Math.min(15, Math.round(idealZ)));
  const n = Math.pow(2, z);

  const x = Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
      )
    )
  );

  // 1. Primary: Google Maps 256x256 Satellite Tile (lyrs=s)
  const googleTileUrl = `https://mt1.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
  try {
    const response = await fetch(googleTileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SatellitePlanner/1.0',
      },
    });
    if (response.ok) {
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength > 200) {
        const b64 = Buffer.from(arrayBuf).toString('base64');
        return `data:${contentType};base64,${b64}`;
      }
    }
  } catch (err) {
    console.warn('[AcquisitionExecutor] Google satellite tile fetch failed, trying Esri fallback:', err);
  }

  // 2. Fallback: Esri World Imagery 256x256 export for the exact (widthM x heightM) geographic bounding box
  try {
    const halfHeightDeg = heightM / 2 / 111_320;
    const halfWidthDeg = widthM / 2 / (111_320 * cosLat);
    const minLng = lng - halfWidthDeg;
    const minLat = Math.max(-89.9, lat - halfHeightDeg);
    const maxLng = lng + halfWidthDeg;
    const maxLat = Math.min(89.9, lat + halfHeightDeg);

    const esriUrl =
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export` +
      `?bbox=${minLng},${minLat},${maxLng},${maxLat}&bboxSR=4326&imageSR=4326&size=256,256&format=jpg&f=image`;

    const response = await fetch(esriUrl);
    if (response.ok) {
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength > 200) {
        const b64 = Buffer.from(arrayBuf).toString('base64');
        return `data:${contentType};base64,${b64}`;
      }
    }
  } catch (err) {
    console.warn('[AcquisitionExecutor] Esri World Imagery fetch failed, using procedural fallback:', err);
  }

  // 3. Offline fallback: 256x256 SVG satellite capture representation
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" fill="#0b2545"/>
    <circle cx="128" cy="128" r="92" fill="#134074" opacity="0.7"/>
    <path d="M20,180 Q90,120 150,160 T240,110" fill="none" stroke="#38bdf8" stroke-width="3"/>
    <rect x="18" y="18" width="220" height="220" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="128" y="122" fill="#f8fafc" font-family="monospace" font-size="12" text-anchor="middle">SAT CAPTURE 256x256</text>
    <text x="128" y="142" fill="#38bdf8" font-family="monospace" font-size="11" text-anchor="middle">${lat.toFixed(3)}, ${lng.toFixed(3)}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Starts (or restarts) the event-driven background acquisition plan executor.
 * Steps:
 *  1. Sleeps until the next acquisition's (acquisition_timestamp - duration / 2) or (acquisition_timestamp + duration / 2).
 *  2. At (acquisition_timestamp - duration / 2), updates status to 'Acquiring' and publishes to NATS JetStream.
 *  3. At (acquisition_timestamp + duration / 2), fetches a 256x256 satellite image, stores it in acquired_image,
 *     updates status to 'Completed', and publishes to NATS JetStream.
 */
export function startAcquisitionPlanExecutor(): void {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
  const generation = ++currentGeneration;
  console.log(`[AcquisitionExecutor] Starting execution cycle (generation #${generation})...`);
  void runExecutorStep(generation);
}

async function runExecutorStep(generation: number): Promise<void> {
  if (generation !== currentGeneration) return;

  try {
    const pool = getPool();
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
         status
       FROM acquisition_plan
       WHERE status IN ('Pending', 'PENDING', 'Acquiring')
       ORDER BY acquisition_timestamp ASC`
    );

    if (generation !== currentGeneration) return;

    const rows = result.rows;
    if (rows.length === 0) {
      console.log('[AcquisitionExecutor] All scheduled acquisitions have completed.');
      return;
    }

    const nowMs = Date.now();
    let nextWakeMs = Infinity;

    for (const row of rows) {
      if (generation !== currentGeneration) return;

      const acqTimeIso =
        row.acquisition_timestamp instanceof Date
          ? row.acquisition_timestamp.toISOString()
          : String(row.acquisition_timestamp);
      const acqTimeMs = new Date(acqTimeIso).getTime();
      const durationSeconds = Number(row.duration_seconds || 60);
      const halfDurationMs = (durationSeconds * 1000) / 2;
      const startAcquireMs = acqTimeMs - halfDurationMs;
      const endAcquireMs = acqTimeMs + halfDurationMs;
      const status = String(row.status);
      const lat = Number(row.center_latitude_deg);
      const lng = Number(row.center_longitude_deg);
      const widthM = Number(row.width_m);
      const heightM = Number(row.height_m);
      const userId = row.user_id || DEFAULT_SYSTEM_USER_ID;

      if (nowMs >= endAcquireMs) {
        // Acquisition window has finished -> fetch 256x256 satellite image, mark 'Completed', and publish to NATS JetStream
        const imageDataUri = await fetchSatelliteImage256(lat, lng, widthM, heightM);
        if (generation !== currentGeneration) return;

        await pool.query(
          `UPDATE acquisition_plan
           SET status = $1, acquired_image = $2
           WHERE id = $3`,
          ['Completed', imageDataUri, row.id]
        );
        console.log(
          `[AcquisitionExecutor] Acquisition ${row.id} (sat ${String(row.satellite_id).slice(-4)}) -> Completed (256x256 image stored)`
        );

        await publishAcquisitionUpdated({
          id: row.id,
          satellite_id: row.satellite_id,
          user_id: userId,
          acquisition_timestamp: acqTimeIso,
          duration_seconds: durationSeconds,
          center_longitude_deg: lng,
          center_latitude_deg: lat,
          width_m: widthM,
          height_m: heightM,
          status: 'Completed',
          acquired_image: imageDataUri,
        });
      } else if (nowMs >= startAcquireMs) {
        // Inside acquisition window [T - D/2, T + D/2) -> ensure status is 'Acquiring' and publish to NATS JetStream
        if (status !== 'Acquiring') {
          await pool.query(
            `UPDATE acquisition_plan
             SET status = $1
             WHERE id = $2`,
            ['Acquiring', row.id]
          );
          console.log(
            `[AcquisitionExecutor] Acquisition ${row.id} (sat ${String(row.satellite_id).slice(-4)}) -> Acquiring`
          );

          await publishAcquisitionUpdated({
            id: row.id,
            satellite_id: row.satellite_id,
            user_id: userId,
            acquisition_timestamp: acqTimeIso,
            duration_seconds: durationSeconds,
            center_longitude_deg: lng,
            center_latitude_deg: lat,
            width_m: widthM,
            height_m: heightM,
            status: 'Acquiring',
            acquired_image: null,
          });
        }
        if (endAcquireMs < nextWakeMs) {
          nextWakeMs = endAcquireMs;
        }
      } else {
        // Future acquisition (nowMs < startAcquireMs) -> next transition is at startAcquireMs
        if (startAcquireMs < nextWakeMs) {
          nextWakeMs = startAcquireMs;
        }
      }
    }

    if (generation !== currentGeneration) return;

    if (nextWakeMs < Infinity) {
      const sleepMs = Math.max(25, nextWakeMs - Date.now());
      schedulerTimeout = setTimeout(() => {
        void runExecutorStep(generation);
      }, sleepMs);
    }
  } catch (err) {
    console.error('[AcquisitionExecutor] Error in execution loop:', err);
    if (generation === currentGeneration) {
      schedulerTimeout = setTimeout(() => {
        void runExecutorStep(generation);
      }, 2000);
    }
  }
}
