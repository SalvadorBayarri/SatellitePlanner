export interface GeoEvent {
  id: string;
  title: string;
  latitude: number;
  longitude: number;
  intensity: number;
  created_at: string;
}

export interface GeoEventsResponse {
  data: GeoEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  services: {
    postgresql: {
      connected: boolean;
      mode: string;
      totalEvents?: number;
    };
    natsJetStream: {
      connected: boolean;
      server?: string;
      stream?: string;
      streamMessages?: number;
      publishedCount: number;
      consumedCount: number;
    };
  };
}

export interface CreateGeoEventInput {
  title: string;
  latitude: number;
  longitude: number;
  intensity: number;
}

export interface SatelliteConfig {
  id: string;
  orbit_altitude_km: number;
  orbit_orientation_deg: number;
  reference_latitude_deg: number;
  reference_direction: 1 | -1;
  reference_timestamp: string;
}

export interface SatelliteFleetResponse {
  data: SatelliteConfig[];
  total: number;
}

export interface UserRow {
  id: string;
  name: string;
}

export interface UsersResponse {
  data: UserRow[];
  total: number;
}

export interface AcquisitionPlanRow {
  id: string;
  satellite_id: string;
  user_id: string;
  acquisition_timestamp: string;
  duration_seconds: number;
  center_longitude_deg: number;
  center_latitude_deg: number;
  width_m: number;
  height_m: number;
  status: 'Reserved' | 'Pending' | 'Acquiring' | 'Completed' | 'Failed' | string;
  acquired_image: string | null;
}

export interface CreateAcquisitionRequestInput {
  longitude: number;
  latitude: number;
  width_m: number;
  height_m: number;
  time_mode: 'ASAP' | 'ABSOLUTE';
  requested_timestamp?: string | null;
}

export interface AcquisitionRequestEvaluationResult {
  request_id: string;
  queued_at: string;
  evaluated_at: string;
  time_mode: 'ASAP' | 'ABSOLUTE';
  requested_timestamp: string | null;
  fulfilled_as_requested: boolean;
  feasible_timestamp: string;
  estimated_cost_points: number;
  acquisition: AcquisitionPlanRow;
}

export interface AcquisitionCancelEventPayload {
  acquisition_id: string;
  request_id?: string;
  satellite_id: string;
  acquisition_timestamp: string;
  reason: 'timeout' | 'acquisition_time_reached' | 'user_canceled';
  message: string;
}

export interface AcquisitionPlanResponse {
  data: AcquisitionPlanRow[];
  added?: number;
  total: number;
}

export interface SatellitePosition extends SatelliteConfig {
  currentLat: number;
  currentLng: number;
  currentDirection: 1 | -1;
  headingDeg: number;
  elapsedMinutes: number;
  color: string;
}

const EARTH_RADIUS_KM = 6371;
const ORBIT_PERIOD_MINUTES = 97;

export const SATELLITE_PALETTE: string[] = [
  '#f43f5e', '#fb7185', '#f472b6', '#e879f9', '#d946ef',
  '#c084fc', '#a855f7', '#a78bfa', '#818cf8', '#6366f1',
  '#60a5fa', '#3b82f6', '#38bdf8', '#0ea5e9', '#22d3ee',
  '#06b6d4', '#2dd4bf', '#14b8a6', '#34d399', '#10b981',
  '#4ade80', '#22c55e', '#a3e635', '#84cc16', '#facc15',
  '#eab308', '#fbbf24', '#f59e0b', '#fb923c', '#f97316',
];

export function getSatelliteColor(sat: SatelliteConfig, indexHint?: number): string {
  if (typeof indexHint === 'number' && indexHint >= 0) {
    return SATELLITE_PALETTE[indexHint % SATELLITE_PALETTE.length];
  }
  const suffix = parseInt(sat.id.slice(-2), 10);
  if (!Number.isNaN(suffix) && suffix >= 1) {
    return SATELLITE_PALETTE[(suffix - 1) % SATELLITE_PALETTE.length];
  }
  const planeIdx = Math.round((sat.orbit_orientation_deg + 90) / 6);
  return SATELLITE_PALETTE[Math.abs(planeIdx) % SATELLITE_PALETTE.length];
}

/**
 * Normalizes any angle in degrees into [-180, +180].
 */
export function normalizeLongitude(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Extrapolates a polar-orbiting satellite's current latitude, longitude, and motion heading from its reference state:
 *  - Unwrapped Latitude = reference_latitude_deg + reference_direction * 360 * (elapsedMinutes / 97)
 *  - Base Longitude = orbit_orientation_deg - 24.5 * (elapsedMinutes / 97)
 *  - Normalized to [-90, +90] for latitude (with polar reflection and 180° meridian flip over the poles)
 *    and [-180, +180] for longitude.
 */
export function computeSatellitePosition(sat: SatelliteConfig, simTimeMs: number = Date.now()): SatellitePosition {
  const refMs = new Date(sat.reference_timestamp).getTime();
  const elapsedMinutes = (simTimeMs - refMs) / 60_000;
  const orbitsElapsed = elapsedMinutes / ORBIT_PERIOD_MINUTES;

  const rawLat = sat.reference_latitude_deg + sat.reference_direction * 360 * orbitsElapsed;
  const rawLng = sat.orbit_orientation_deg - 24.5 * orbitsElapsed;

  // Fold rawLat into [-180, +180] first
  const wrappedLat = ((((rawLat + 180) % 360) + 360) % 360) - 180;

  let currentLat: number;
  let currentDirection: 1 | -1 = sat.reference_direction;
  let poleCrossFlip = 0;

  if (wrappedLat > 90) {
    currentLat = 180 - wrappedLat;
    currentDirection = (sat.reference_direction * -1) as 1 | -1;
    poleCrossFlip = 180;
  } else if (wrappedLat < -90) {
    currentLat = -180 - wrappedLat;
    currentDirection = (sat.reference_direction * -1) as 1 | -1;
    poleCrossFlip = 180;
  } else {
    currentLat = wrappedLat;
  }

  const currentLng = normalizeLongitude(rawLng + poleCrossFlip);

  // Compute local tangent velocity vector (East, North) to orient the 3D direction arrow
  const latRad = (currentLat * Math.PI) / 180;
  const vNorth = currentDirection * 360;
  const vEast = -24.5 * Math.max(0.05, Math.cos(latRad));
  // Angle in degrees counter-clockwise from North (+Y in local surface frame)
  const headingDeg = (Math.atan2(-vEast, vNorth) * 180) / Math.PI;

  return {
    ...sat,
    currentLat,
    currentLng,
    currentDirection,
    headingDeg,
    elapsedMinutes,
    color: getSatelliteColor(sat),
  };
}

export function getGlobeAltitudeRatio(altitudeKm: number): number {
  return altitudeKm / EARTH_RADIUS_KM;
}

/**
 * Computes the astronomical subsolar point (latitude and longitude where the Sun is directly overhead)
 * for any UTC timestamp (ms), accounting for Earth's axial tilt (solar declination), equation of time,
 * and UTC solar hour angle.
 */
export function computeSubsolarPoint(timeMs: number): { lat: number; lng: number } {
  // Days since J2000.0 epoch (2000-01-01T12:00:00Z)
  const jd = timeMs / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;

  // Mean longitude of the Sun (deg)
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  // Mean anomaly of the Sun (deg -> rad)
  const gDeg = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
  const gRad = (gDeg * Math.PI) / 180;

  // Ecliptic longitude of the Sun (deg -> rad)
  const lambdaDeg = L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad);
  const lambdaRad = (lambdaDeg * Math.PI) / 180;

  // Obliquity of the ecliptic (deg -> rad)
  const epsilonDeg = 23.439 - 0.0000004 * n;
  const epsilonRad = (epsilonDeg * Math.PI) / 180;

  // Solar declination = subsolar latitude (deg)
  const sinDec = Math.sin(epsilonRad) * Math.sin(lambdaRad);
  const subsolarLat = (Math.asin(Math.max(-1, Math.min(1, sinDec))) * 180) / Math.PI;

  // Right ascension (deg) & Equation of Time (minutes)
  const raDeg =
    ((Math.atan2(Math.cos(epsilonRad) * Math.sin(lambdaRad), Math.cos(lambdaRad)) * 180) /
      Math.PI +
      360) %
    360;
  let deltaRa = L - raDeg;
  if (deltaRa > 180) deltaRa -= 360;
  if (deltaRa < -180) deltaRa += 360;
  const equationOfTimeMinutes = 4 * deltaRa;

  // Fractional UTC day in minutes [0, 1440)
  const utcDate = new Date(timeMs);
  const utcMinutes =
    utcDate.getUTCHours() * 60 +
    utcDate.getUTCMinutes() +
    utcDate.getUTCSeconds() / 60 +
    utcDate.getUTCMilliseconds() / 60_000;

  // Subsolar longitude: at 12:00 solar time, the Sun is over 0° (Greenwich), moving west 15°/hour
  const rawSubsolarLng = -15 * ((utcMinutes - 720 + equationOfTimeMinutes) / 60);
  const subsolarLng = normalizeLongitude(rawSubsolarLng);

  return { lat: subsolarLat, lng: subsolarLng };
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1';

export async function fetchGeoEvents(page = 1, limit = 100): Promise<GeoEventsResponse> {
  const response = await fetch(`${API_BASE_URL}/geo-events?page=${page}&limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch geo-events: ${response.statusText}`);
  }
  return response.json();
}

export async function createGeoEvent(payload: CreateGeoEventInput): Promise<{
  status: string;
  message: string;
  jetstream: { stream: string; seq: number };
  event: GeoEvent;
}> {
  const response = await fetch(`${API_BASE_URL}/geo-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to publish event: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchSatellites(): Promise<SatelliteFleetResponse> {
  const response = await fetch(`${API_BASE_URL}/satellites`);
  if (!response.ok) {
    throw new Error(`Failed to fetch satellite fleet: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchUsers(): Promise<UsersResponse> {
  const response = await fetch(`${API_BASE_URL}/users`);
  if (!response.ok) {
    throw new Error(`Failed to fetch users: ${response.statusText}`);
  }
  return response.json();
}

export async function initializeAcquisitionPlan(): Promise<AcquisitionPlanResponse> {
  const response = await fetch(`${API_BASE_URL}/acquisition-plan/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to initialize acquisition plan: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchAcquisitionPlan(satelliteId?: string): Promise<AcquisitionPlanResponse> {
  const query = satelliteId ? `?satellite_id=${encodeURIComponent(satelliteId)}` : '';
  const response = await fetch(`${API_BASE_URL}/acquisition-plan${query}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch acquisition plan: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchAcquisitionById(id: string): Promise<{ data: AcquisitionPlanRow }> {
  const response = await fetch(`${API_BASE_URL}/acquisition-plan/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch acquisition item: ${response.statusText}`);
  }
  return response.json();
}

export async function submitAcquisitionRequest(
  payload: CreateAcquisitionRequestInput
): Promise<{
  status: string;
  request: {
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
  };
}> {
  const response = await fetch(`${API_BASE_URL}/acquisition-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to submit acquisition request: ${response.statusText}`);
  }
  return response.json();
}

export async function confirmReservedAcquisition(
  id: string
): Promise<{ status: string; data: AcquisitionPlanRow }> {
  const response = await fetch(`${API_BASE_URL}/acquisition-plan/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to confirm acquisition request: ${response.statusText}`);
  }
  return response.json();
}

export async function cancelReservedAcquisition(
  id: string
): Promise<{ status: string; acquisition_id: string }> {
  const response = await fetch(`${API_BASE_URL}/acquisition-plan/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to cancel acquisition request: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Subscribes to Server-Sent Events (SSE) backed by NATS JetStream (ACQUISITION_STREAM)
 * to receive real-time acquisition plan state updates (`Reserved`, `Pending`, `Acquiring`, `Completed`),
 * request evaluation notifications (`request_evaluated`), and cancellation events (`cancel`).
 */
export function subscribeToAcquisitionUpdates(
  onUpdate: (row: AcquisitionPlanRow) => void,
  onRequestEvaluated?: (evaluation: AcquisitionRequestEvaluationResult) => void,
  onCanceled?: (cancelEvent: AcquisitionCancelEventPayload) => void
): () => void {
  const eventSource = new EventSource(`${API_BASE_URL}/acquisition-plan/stream`);
  eventSource.onmessage = (event) => {
    try {
      const updated: AcquisitionPlanRow = JSON.parse(event.data);
      if (updated && updated.id) {
        onUpdate(updated);
      }
    } catch (err) {
      console.error('Failed to parse SSE acquisition update:', err);
    }
  };
  eventSource.addEventListener('request_evaluated', (event: MessageEvent) => {
    try {
      const evaluation: AcquisitionRequestEvaluationResult = JSON.parse(event.data);
      if (evaluation && evaluation.acquisition) {
        onUpdate(evaluation.acquisition);
        onRequestEvaluated?.(evaluation);
      }
    } catch (err) {
      console.error('Failed to parse SSE request_evaluated event:', err);
    }
  });
  eventSource.addEventListener('cancel', (event: MessageEvent) => {
    try {
      const cancelPayload: AcquisitionCancelEventPayload = JSON.parse(event.data);
      if (cancelPayload && cancelPayload.acquisition_id) {
        onCanceled?.(cancelPayload);
      }
    } catch (err) {
      console.error('Failed to parse SSE cancel event:', err);
    }
  });
  return () => {
    eventSource.close();
  };
}
