import React, { useEffect, useState, useCallback } from 'react';
import {
  Satellite,
  Radio,
  Activity,
  PlusCircle,
  RefreshCw,
  MapPin,
  Database,
  Zap,
  Globe2,
  X,
} from 'lucide-react';
import { GlobeVisualizer } from './components/GlobeVisualizer';
import {
  GeoEvent,
  HealthResponse,
  fetchGeoEvents,
  createGeoEvent,
  fetchHealth,
} from './services/api';
import './App.css';

export function App() {
  const [events, setEvents] = useState<GeoEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<GeoEvent | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);

  // New event form state
  const [title, setTitle] = useState<string>('');
  const [latitude, setLatitude] = useState<string>('28.5729');
  const [longitude, setLongitude] = useState<string>('-80.6490');
  const [intensity, setIntensity] = useState<string>('0.93');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [lastAck, setLastAck] = useState<{ stream: string; seq: number } | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [eventsRes, healthRes] = await Promise.all([
        fetchGeoEvents(1, 100),
        fetchHealth().catch(() => null),
      ]);
      setEvents(eventsRes.data);
      if (healthRes) {
        setHealth(healthRes);
      }
    } catch (err: any) {
      setError(err.message || 'Unable to connect to Backend API');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 6000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handlePublishEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await createGeoEvent({
        title: title.trim(),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        intensity: parseFloat(intensity),
      });
      setLastAck(res.jetstream);
      setTitle('');

      // Wait briefly for the NATS JetStream durable consumer to write to PostgreSQL, then refresh
      setTimeout(async () => {
        await loadData();
        setSelectedEvent(res.event);
      }, 300);
    } catch (err: any) {
      setError(err.message || 'Failed to publish event');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      {/* 3D WebGL Globe Background */}
      <GlobeVisualizer
        events={events}
        selectedEvent={selectedEvent}
        onSelectEvent={(ev) => {
          setSelectedEvent(ev);
          setAutoRotate(false);
        }}
        autoRotate={autoRotate}
      />

      {/* Top Telemetry Bar */}
      <header className="top-hud">
        <div className="brand-block">
          <div className="brand-icon">
            <Satellite size={22} />
          </div>
          <div>
            <h1>SATELLITE PLANNER</h1>
            <p className="subtitle">NATS JetStream + PostgreSQL 3D Geospatial Telemetry</p>
          </div>
        </div>

        <div className="status-pills">
          <div className={`status-pill ${health?.services.postgresql.connected ? 'online' : 'offline'}`}>
            <Database size={14} />
            <span>
              PG: {health?.services.postgresql.connected ? 'ONLINE' : 'CONNECTING'}
            </span>
          </div>

          <div className={`status-pill ${health?.services.natsJetStream.connected ? 'online' : 'offline'}`}>
            <Zap size={14} />
            <span>
              NATS JS: {health?.services.natsJetStream.stream || 'GEO_STREAM'} (
              {health?.services.natsJetStream.streamMessages ?? 0} msgs)
            </span>
          </div>

          <button
            type="button"
            className={`hud-btn ${autoRotate ? 'active' : ''}`}
            onClick={() => setAutoRotate((prev) => !prev)}
            title="Toggle Orbit Auto-Rotation"
          >
            <Globe2 size={15} />
            <span>{autoRotate ? 'Orbiting' : 'Paused'}</span>
          </button>

          <button
            type="button"
            className="hud-btn"
            onClick={loadData}
            title="Refresh Telemetry"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            <span>Sync ({events.length})</span>
          </button>
        </div>
      </header>

      {/* Left Panel: Event Ingestion Publisher & Live Feed */}
      <aside className="left-panel">
        <section className="glass-card">
          <div className="card-header">
            <PlusCircle size={16} className="accent-cyan" />
            <h2>Publish Geo-Event (JetStream)</h2>
          </div>

          <form onSubmit={handlePublishEvent} className="ingest-form">
            <div className="field-group">
              <label htmlFor="event-title">Telemetry Event Title</label>
              <input
                id="event-title"
                type="text"
                placeholder="e.g., Cape Canaveral Downlink Burst"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="field-row">
              <div className="field-group">
                <label htmlFor="event-lat">Latitude (°)</label>
                <input
                  id="event-lat"
                  type="number"
                  step="0.0001"
                  min="-90"
                  max="90"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  required
                />
              </div>
              <div className="field-group">
                <label htmlFor="event-lng">Longitude (°)</label>
                <input
                  id="event-lng"
                  type="number"
                  step="0.0001"
                  min="-180"
                  max="180"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  required
                />
              </div>
              <div className="field-group">
                <label htmlFor="event-int">Intensity</label>
                <input
                  id="event-int"
                  type="number"
                  step="0.01"
                  min="0.1"
                  max="1.0"
                  value={intensity}
                  onChange={(e) => setIntensity(e.target.value)}
                  required
                />
              </div>
            </div>

            <button type="submit" className="submit-btn" disabled={submitting}>
              <Radio size={15} />
              <span>{submitting ? 'Publishing to NATS...' : 'Emit to geo.events.created'}</span>
            </button>

            {lastAck && (
              <div className="ack-banner">
                ACK Stream: <strong>{lastAck.stream}</strong> • Seq #{lastAck.seq}
              </div>
            )}
            {error && <div className="error-banner">{error}</div>}
          </form>
        </section>

        <section className="glass-card feed-card">
          <div className="card-header">
            <Activity size={16} className="accent-cyan" />
            <h2>Global Telemetry Stream ({events.length})</h2>
          </div>

          <div className="events-list">
            {events.map((ev) => {
              const isSelected = selectedEvent?.id === ev.id;
              return (
                <div
                  key={ev.id}
                  className={`event-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedEvent(ev);
                    setAutoRotate(false);
                  }}
                >
                  <div className="event-item-top">
                    <span className="event-title">{ev.title}</span>
                    <span
                      className={`intensity-badge ${
                        ev.intensity >= 0.9
                          ? 'critical'
                          : ev.intensity >= 0.8
                          ? 'high'
                          : 'normal'
                      }`}
                    >
                      {(ev.intensity * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="event-coords">
                    <MapPin size={12} />
                    <span>
                      {ev.latitude.toFixed(3)}°, {ev.longitude.toFixed(3)}°
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </aside>

      {/* Selected 3D Marker Tooltip Modal */}
      {selectedEvent && (
        <div className="selected-tooltip-card" role="dialog" aria-label="Selected Event Details">
          <div className="tooltip-header">
            <span className="tooltip-tag">ACTIVE 3D MARKER TELEMETRY</span>
            <button
              type="button"
              className="close-btn"
              onClick={() => setSelectedEvent(null)}
              aria-label="Close details"
            >
              <X size={16} />
            </button>
          </div>
          <h3>{selectedEvent.title}</h3>
          <div className="tooltip-grid">
            <div>
              <span className="label">LATITUDE</span>
              <span className="mono">{selectedEvent.latitude.toFixed(5)}°</span>
            </div>
            <div>
              <span className="label">LONGITUDE</span>
              <span className="mono">{selectedEvent.longitude.toFixed(5)}°</span>
            </div>
            <div>
              <span className="label">SIGNAL INTENSITY</span>
              <span className="mono highlight">{(selectedEvent.intensity * 100).toFixed(1)}%</span>
            </div>
            <div>
              <span className="label">TIMESTAMP</span>
              <span className="mono">
                {new Date(selectedEvent.created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            </div>
          </div>
          <div className="tooltip-id">UUID: {selectedEvent.id}</div>
        </div>
      )}
    </div>
  );
}

export default App;
