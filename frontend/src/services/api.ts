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
