import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  Clock,
  RotateCcw,
  Gauge,
  GripHorizontal,
  X,
} from 'lucide-react';
import { GlobeVisualizer } from './components/GlobeVisualizer';
import {
  GeoEvent,
  SatelliteConfig,
  SatellitePosition,
  HealthResponse,
  fetchGeoEvents,
  createGeoEvent,
  fetchHealth,
  fetchSatellites,
  computeSatellitePosition,
} from './services/api';
import './App.css';

function formatUtcTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

interface DraggablePanelProps {
  initialPosition: { x: number; y: number };
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  children: React.ReactNode;
}

const DraggablePanel: React.FC<DraggablePanelProps> = ({
  initialPosition,
  className = '',
  style,
  ariaLabel,
  children,
}) => {
  const [pos, setPos] = useState<{ x: number; y: number }>(initialPosition);
  const [dragging, setDragging] = useState<boolean>(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Allow normal interaction with buttons, inputs, selects, or links inside the panel
    if (target.closest('button, input, select, textarea, a, label')) {
      return;
    }
    e.stopPropagation();
    setDragging(true);
    dragOffsetRef.current = {
      dx: e.clientX - pos.x,
      dy: e.clientY - pos.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.stopPropagation();
    const nextX = Math.max(8, Math.min(window.innerWidth - 120, e.clientX - dragOffsetRef.current.dx));
    const nextY = Math.max(8, Math.min(window.innerHeight - 60, e.clientY - dragOffsetRef.current.dy));
    setPos({ x: nextX, y: nextY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.stopPropagation();
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore if not captured
    }
  };

  return (
    <div
      className={`${className} draggable-panel ${dragging ? 'is-dragging' : ''}`}
      style={{
        ...style,
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        right: 'auto',
        bottom: 'auto',
      }}
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {children}
    </div>
  );
};

export function App() {
  const [events, setEvents] = useState<GeoEvent[]>([]);
  const [satellites, setSatellites] = useState<SatelliteConfig[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<GeoEvent | null>(null);
  const [selectedSatelliteId, setSelectedSatelliteId] = useState<string | null>(null);
  const [trackSelectedSatellite, setTrackSelectedSatellite] = useState<boolean>(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [showGeoEvents, setShowGeoEvents] = useState<boolean>(false);

  // Simulation Clock State (anchors + speed factor 1x, 10x, 100x, 1000x)
  const [speedFactor, setSpeedFactor] = useState<number>(1);
  const clockAnchorRef = useRef<{ realMs: number; simMs: number; speed: number }>({
    realMs: Date.now(),
    simMs: Date.now(),
    speed: 1,
  });
  const [clockDisplay, setClockDisplay] = useState<{ utcMs: number; simMs: number }>({
    utcMs: Date.now(),
    simMs: Date.now(),
  });

  const getSimulatedTimeMs = useCallback(() => {
    const now = Date.now();
    const { realMs, simMs, speed } = clockAnchorRef.current;
    return simMs + (now - realMs) * speed;
  }, []);

  const handleSpeedChange = (newSpeed: number) => {
    const now = Date.now();
    const currentSim = getSimulatedTimeMs();
    clockAnchorRef.current = {
      realMs: now,
      simMs: currentSim,
      speed: newSpeed,
    };
    setSpeedFactor(newSpeed);
    setClockDisplay({ utcMs: now, simMs: currentSim });
  };

  const handleResetSimulatedTime = () => {
    const now = Date.now();
    clockAnchorRef.current = {
      realMs: now,
      simMs: now,
      speed: speedFactor,
    };
    setClockDisplay({ utcMs: now, simMs: now });
  };

  // Update the clock popup & live selected satellite telemetry every 100ms
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockDisplay({
        utcMs: now,
        simMs: getSimulatedTimeMs(),
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [getSimulatedTimeMs]);

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

  // Read satellite fleet configuration at startup
  useEffect(() => {
    fetchSatellites()
      .then((res) => setSatellites(res.data))
      .catch((err) => console.error('Failed to load satellite fleet:', err));
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

  // Compute live position of the currently selected satellite (remains open until another satellite is selected or closed)
  const activeSatellite: SatellitePosition | null = React.useMemo(() => {
    if (!selectedSatelliteId) return null;
    const cfg = satellites.find((s) => s.id === selectedSatelliteId);
    if (!cfg) return null;
    return computeSatellitePosition(cfg, clockDisplay.simMs);
  }, [selectedSatelliteId, satellites, clockDisplay.simMs]);

  return (
    <div className="app-shell">
      {/* 3D WebGL Globe Background */}
      <GlobeVisualizer
        events={showGeoEvents ? events : []}
        satellites={satellites}
        selectedEvent={showGeoEvents ? selectedEvent : null}
        selectedSatelliteId={selectedSatelliteId}
        trackSelectedSatellite={trackSelectedSatellite}
        onSelectEvent={(ev) => {
          setSelectedEvent(ev);
          setAutoRotate(false);
        }}
        onSelectSatellite={(sat) => {
          setSelectedSatelliteId(sat.id);
        }}
        getSimulatedTimeMs={getSimulatedTimeMs}
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
          <div
            className="status-pill online clickable-pill"
            role="button"
            tabIndex={0}
            title="Click to open Satellite Information Panel"
            onClick={() => {
              if (!selectedSatelliteId && satellites.length > 0) {
                setSelectedSatelliteId(satellites[0].id);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !selectedSatelliteId && satellites.length > 0) {
                setSelectedSatelliteId(satellites[0].id);
              }
            }}
          >
            <Satellite size={14} />
            <span>FLEET: {satellites.length} SATS</span>
          </div>
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

          <label className="hud-switch" title="Show or hide Geo-Events UI panels and 3D markers">
            <input
              type="checkbox"
              checked={showGeoEvents}
              onChange={(e) => {
                const enabled = e.target.checked;
                setShowGeoEvents(enabled);
                if (!enabled) {
                  setSelectedEvent(null);
                }
              }}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
            <span className="switch-label">Geo-Events</span>
          </label>

          <button
            type="button"
            className={`hud-btn ${autoRotate ? 'active' : ''}`}
            onClick={() => setAutoRotate((prev) => !prev)}
            title="Toggle Orbit Auto-Rotation"
          >
            <Globe2 size={15} />
            <span>{autoRotate ? 'Orbiting' : 'Paused'}</span>
          </button>

          {showGeoEvents && (
            <button
              type="button"
              className="hud-btn"
              onClick={loadData}
              title="Refresh Telemetry"
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
              <span>Sync ({events.length})</span>
            </button>
          )}
        </div>
      </header>

      {/* Draggable Orbital Time & Simulation Speed Control Popup Panel */}
      <DraggablePanel
        className="time-control-panel glass-card"
        initialPosition={{ x: Math.max(20, window.innerWidth - 360), y: 96 }}
        ariaLabel="Orbital Time Simulation Controls"
      >
        <div className="card-header drag-handle-header">
          <div className="card-header-left">
            <Clock size={16} className="accent-cyan" />
            <h2>Orbital Time & Speed Control</h2>
          </div>
          <GripHorizontal size={15} className="drag-grip-icon" />
        </div>

        <div className="time-readouts">
          <div className="time-row">
            <span className="time-label">UNIVERSAL TIME (UTC)</span>
            <span className="time-value">{formatUtcTimestamp(clockDisplay.utcMs)}</span>
          </div>
          <div className="time-row simulated">
            <span className="time-label">SIMULATED TIME</span>
            <span className="time-value highlight">{formatUtcTimestamp(clockDisplay.simMs)}</span>
          </div>
        </div>

        <div className="time-controls-row">
          <div className="speed-select-group">
            <label htmlFor="sim-speed-select">
              <Gauge size={13} />
              <span>Speed Factor</span>
            </label>
            <select
              id="sim-speed-select"
              value={speedFactor}
              onChange={(e) => handleSpeedChange(Number(e.target.value))}
              className="speed-select"
            >
              <option value={1}>1x (Real-Time)</option>
              <option value={10}>10x</option>
              <option value={100}>100x</option>
              <option value={1000}>1000x</option>
            </select>
          </div>

          <button
            type="button"
            className="reset-time-btn"
            onClick={handleResetSimulatedTime}
            title="Reset simulated time to current Universal Time (UTC)"
          >
            <RotateCcw size={14} />
            <span>Reset to UTC</span>
          </button>
        </div>
      </DraggablePanel>

      {/* Left Panel: Event Ingestion Publisher & Live Feed (Shown only when Geo-Events switch is ON) */}
      {showGeoEvents && (
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
      )}

      {/* Draggable Persistent Selected Satellite Info Popup */}
      {activeSatellite && (
        <DraggablePanel
          className="selected-satellite-card"
          initialPosition={{ x: Math.max(20, window.innerWidth - 360), y: 315 }}
          style={{ borderColor: activeSatellite.color }}
          ariaLabel="Selected Satellite Telemetry"
        >
          <div className="tooltip-header drag-handle-header">
            <span className="tooltip-tag" style={{ color: activeSatellite.color }}>
              POLAR ORBIT SATELLITE TELEMETRY
            </span>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setSelectedSatelliteId(null)}
                aria-label="Close satellite info"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="sat-selector-row">
            <span
              className="sat-color-dot"
              style={{
                backgroundColor: activeSatellite.color,
                boxShadow: `0 0 10px ${activeSatellite.color}`,
              }}
            />
            <select
              aria-label="Select Satellite ID"
              className="sat-id-select"
              value={activeSatellite.id}
              onChange={(e) => setSelectedSatelliteId(e.target.value)}
              style={{ borderColor: `${activeSatellite.color}66` }}
            >
              {satellites.map((sat) => {
                const shortCode = sat.id.slice(-4).toUpperCase();
                return (
                  <option key={sat.id} value={sat.id}>
                    SAT-{shortCode} ({sat.orbit_orientation_deg.toFixed(0)}° EQ • {sat.orbit_altitude_km.toFixed(0)} km)
                  </option>
                );
              })}
            </select>
          </div>
          <div className="tooltip-grid">
            <div>
              <span className="label">CURRENT LATITUDE</span>
              <span className="mono">{activeSatellite.currentLat.toFixed(4)}°</span>
            </div>
            <div>
              <span className="label">CURRENT LONGITUDE</span>
              <span className="mono">{activeSatellite.currentLng.toFixed(4)}°</span>
            </div>
            <div>
              <span className="label">ORBIT ALTITUDE</span>
              <span className="mono" style={{ color: activeSatellite.color }}>
                {activeSatellite.orbit_altitude_km.toFixed(1)} km
              </span>
            </div>
            <div>
              <span className="label">CAPTURE FOOTPRINT</span>
              <span className="mono" style={{ color: activeSatellite.color }}>
                300 × 300 km
              </span>
            </div>
            <div>
              <span className="label">MOTION DIRECTION</span>
              <span className="mono">
                {activeSatellite.currentDirection === 1 ? 'Ascending (+1)' : 'Descending (-1)'}
              </span>
            </div>
            <div>
              <span className="label">ORBIT ORIENTATION</span>
              <span className="mono">{activeSatellite.orbit_orientation_deg.toFixed(1)}° EQ</span>
            </div>
          </div>
          <div className="sat-track-toggle-row">
            <label
              className="hud-switch sat-track-switch"
              title="Automatically keep the 3D globe centered on this satellite as it orbits"
            >
              <input
                type="checkbox"
                checked={trackSelectedSatellite}
                onChange={(e) => setTrackSelectedSatellite(e.target.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              <span className="switch-label">Track Satellite Motion</span>
            </label>
          </div>
          <div className="tooltip-id">UUID: {activeSatellite.id}</div>
        </DraggablePanel>
      )}

      {/* Draggable Selected 3D Geo-Event Marker Tooltip Modal */}
      {showGeoEvents && selectedEvent && (
        <DraggablePanel
          className="selected-tooltip-card"
          initialPosition={{ x: Math.max(20, window.innerWidth - 364), y: Math.max(120, window.innerHeight - 230) }}
          ariaLabel="Selected Event Details"
        >
          <div className="tooltip-header drag-handle-header">
            <span className="tooltip-tag">ACTIVE 3D MARKER TELEMETRY</span>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setSelectedEvent(null)}
                aria-label="Close details"
              >
                <X size={16} />
              </button>
            </div>
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
        </DraggablePanel>
      )}
    </div>
  );
}

export default App;
