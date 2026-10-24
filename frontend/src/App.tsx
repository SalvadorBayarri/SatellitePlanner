import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Satellite,
  Radio,
  Activity,
  PlusCircle,
  RefreshCw,
  MapPin,
  Camera,
  Globe2,
  Clock,
  RotateCcw,
  Gauge,
  GripHorizontal,
  Image as ImageIcon,
  Crosshair,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  User as UserIcon,
  X,
} from 'lucide-react';
import { GlobeVisualizer } from './components/GlobeVisualizer';
import {
  GeoEvent,
  SatelliteConfig,
  SatellitePosition,
  UserRow,
  AcquisitionPlanRow,
  HealthResponse,
  fetchGeoEvents,
  createGeoEvent,
  fetchHealth,
  fetchSatellites,
  fetchUsers,
  initializeAcquisitionPlan,
  fetchAcquisitionPlan,
  fetchAcquisitionById,
  subscribeToAcquisitionUpdates,
  computeSatellitePosition,
  getSatelliteColor,
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
    if (
      target.closest(
        'button, input, select, textarea, a, label, .acq-plan-list-container, .acq-plan-list-item'
      )
    ) {
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
  const [users, setUsers] = useState<UserRow[]>([
    { id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01', name: 'system' },
    { id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02', name: 'demo' },
  ]);
  const [acquisitionPlan, setAcquisitionPlan] = useState<AcquisitionPlanRow[]>([]);
  const [selectedAcquisitionId, setSelectedAcquisitionId] = useState<string | null>(null);
  const [acquisitionFocusKey, setAcquisitionFocusKey] = useState<number>(0);
  const [showImagePopup, setShowImagePopup] = useState<boolean>(false);
  const [showAcquisitionPlanWindow, setShowAcquisitionPlanWindow] = useState<boolean>(false);
  const [planUserFilter, setPlanUserFilter] = useState<string>('ALL');

  // Request Image Dialog state
  const [showRequestImageDialog, setShowRequestImageDialog] = useState<boolean>(false);
  const [isPickingGlobeLocation, setIsPickingGlobeLocation] = useState<boolean>(false);
  const [requestLongitude, setRequestLongitude] = useState<string>('-3.7038');
  const [requestLatitude, setRequestLatitude] = useState<string>('40.4168');
  const [requestAreaSizeKm, setRequestAreaSizeKm] = useState<number>(25);
  const [requestTimeMode, setRequestTimeMode] = useState<'ASAP' | 'ABSOLUTE'>('ASAP');
  const [requestAbsoluteTime, setRequestAbsoluteTime] = useState<string>(() =>
    new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 16)
  );
  const [selectedEvent, setSelectedEvent] = useState<GeoEvent | null>(null);
  const [selectedSatelliteId, setSelectedSatelliteId] = useState<string | null>(null);
  const [trackSelectedSatellite, setTrackSelectedSatellite] = useState<boolean>(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [showGeoEvents] = useState<boolean>(false);

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

  // Read satellite fleet, users, and initialize the 3-hour acquisition plan at startup
  const startupInitRef = useRef<boolean>(false);
  useEffect(() => {
    if (startupInitRef.current) return;
    startupInitRef.current = true;

    Promise.all([
      fetchSatellites(),
      initializeAcquisitionPlan(),
      fetchUsers().catch(() => null),
    ])
      .then(([satRes, planRes, usersRes]) => {
        setSatellites(satRes.data);
        setAcquisitionPlan(planRes.data);
        if (usersRes && usersRes.data.length > 0) {
          setUsers(usersRes.data);
        }
      })
      .catch((err) => console.error('Failed to load satellite fleet or acquisition plan:', err));
  }, []);

  // Subscribe to real-time acquisition status updates via Server-Sent Events (NATS JetStream push)
  useEffect(() => {
    const unsubscribe = subscribeToAcquisitionUpdates((updatedRow) => {
      setAcquisitionPlan((prev) => {
        const exists = prev.some((r) => r.id === updatedRow.id);
        if (!exists) return prev;
        return prev.map((r) => (r.id === updatedRow.id ? updatedRow : r));
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 6000);
    return () => clearInterval(interval);
  }, [loadData]);

  const getUserName = useCallback(
    (userId?: string | null): string => {
      if (!userId) return 'system';
      const found = users.find((u) => u.id === userId);
      return found ? found.name : 'system';
    },
    [users]
  );

  const handleRefreshFullAcquisitionPlan = useCallback(async () => {
    try {
      const latestPlanRes = await fetchAcquisitionPlan();
      setAcquisitionPlan(latestPlanRes.data);
    } catch (err) {
      console.error('Failed to refresh acquisition plan list:', err);
    }
  }, []);

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

  // Filter acquisition plan rows belonging to the currently selected satellite
  const selectedSatelliteAcquisitions = React.useMemo(() => {
    if (!selectedSatelliteId) return [];
    return acquisitionPlan.filter((row) => row.satellite_id === selectedSatelliteId);
  }, [acquisitionPlan, selectedSatelliteId]);

  // Keep selectedAcquisitionId synchronized with the active satellite's acquisition rows
  useEffect(() => {
    if (selectedSatelliteAcquisitions.length === 0) {
      setSelectedAcquisitionId(null);
      return;
    }
    const stillExists = selectedSatelliteAcquisitions.some((r) => r.id === selectedAcquisitionId);
    if (!stillExists) {
      setSelectedAcquisitionId(selectedSatelliteAcquisitions[0].id);
    }
  }, [selectedSatelliteAcquisitions, selectedAcquisitionId]);

  const activeAcquisitionRow = React.useMemo(() => {
    if (!selectedAcquisitionId) return selectedSatelliteAcquisitions[0] ?? null;
    return (
      selectedSatelliteAcquisitions.find((r) => r.id === selectedAcquisitionId) ??
      selectedSatelliteAcquisitions[0] ??
      null
    );
  }, [selectedSatelliteAcquisitions, selectedAcquisitionId]);

  const activeAcquisitionId = activeAcquisitionRow?.id ?? null;

  // Fetch the latest fields and status of a specific acquisition from the backend
  const refreshAcquisitionRow = useCallback(async (acqId: string) => {
    try {
      const res = await fetchAcquisitionById(acqId);
      const updated = res.data;
      setAcquisitionPlan((prev) =>
        prev.map((row) => (row.id === updated.id ? updated : row))
      );
    } catch (err) {
      console.error('Failed to refresh selected acquisition row:', err);
    }
  }, []);

  // Automatically fetch current fields from the backend whenever a new acquisition is selected
  useEffect(() => {
    if (!activeAcquisitionId || !selectedSatelliteId) return;
    void refreshAcquisitionRow(activeAcquisitionId);
  }, [activeAcquisitionId, selectedSatelliteId, refreshAcquisitionRow]);

  // Select a specific acquisition row: open its satellite info panel, select it in the dropdown, zoom & refresh status
  const selectAcquisitionAndOpenPanel = useCallback(
    (row: AcquisitionPlanRow) => {
      setSelectedSatelliteId(row.satellite_id);
      setSelectedAcquisitionId(row.id);
      setAcquisitionFocusKey((prev) => prev + 1);
      void refreshAcquisitionRow(row.id);
    },
    [refreshAcquisitionRow]
  );

  // Find the acquisition in the plan closest to current real time (UTC), open the satellite dialog, and select it
  const handleSelectNextAcquisition = useCallback(async () => {
    let currentPlan = acquisitionPlan;
    try {
      const latestPlanRes = await fetchAcquisitionPlan();
      if (latestPlanRes.data.length > 0) {
        currentPlan = latestPlanRes.data;
        setAcquisitionPlan(currentPlan);
      }
    } catch {
      // Fallback to in-memory acquisitionPlan if network request fails
    }

    if (currentPlan.length === 0) return;

    const nowRealMs = Date.now();

    // Prefer acquisitions whose window has not yet ended (upcoming or currently Acquiring),
    // and pick the one closest to nowRealMs; fallback to closest across all rows if all have ended.
    const upcomingOrActive = currentPlan.filter((row) => {
      const acqMs = new Date(row.acquisition_timestamp).getTime();
      const halfDurMs = ((row.duration_seconds || 60) * 1000) / 2;
      return acqMs + halfDurMs >= nowRealMs && row.status.toLowerCase() !== 'completed';
    });

    const poolToSearch = upcomingOrActive.length > 0 ? upcomingOrActive : currentPlan;

    let closestRow = poolToSearch[0];
    let minDiff = Math.abs(new Date(closestRow.acquisition_timestamp).getTime() - nowRealMs);

    for (let i = 1; i < poolToSearch.length; i++) {
      const candidate = poolToSearch[i];
      const diff = Math.abs(new Date(candidate.acquisition_timestamp).getTime() - nowRealMs);
      if (diff < minDiff) {
        minDiff = diff;
        closestRow = candidate;
      }
    }

    selectAcquisitionAndOpenPanel(closestRow);
  }, [acquisitionPlan, selectAcquisitionAndOpenPanel]);

  // All acquisition plan rows sorted chronologically by acquisition_timestamp
  const sortedAcquisitionPlan = React.useMemo(() => {
    return [...acquisitionPlan].sort((a, b) => {
      const diff =
        new Date(a.acquisition_timestamp).getTime() -
        new Date(b.acquisition_timestamp).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }, [acquisitionPlan]);

  // Filtered acquisition plan rows for the "See Acquisition Plan" floating window
  const filteredAcquisitionPlan = React.useMemo(() => {
    if (planUserFilter === 'ALL') return sortedAcquisitionPlan;
    const selectedUser = users.find((u) => u.id === planUserFilter || u.name === planUserFilter);
    return sortedAcquisitionPlan.filter((row) => {
      if (row.user_id && row.user_id === planUserFilter) return true;
      if (selectedUser && getUserName(row.user_id) === selectedUser.name) return true;
      return false;
    });
  }, [sortedAcquisitionPlan, planUserFilter, users, getUserName]);

  const currentGlobalAcquisitionIndex = React.useMemo(() => {
    if (!activeAcquisitionId || !selectedSatelliteId) return -1;
    return sortedAcquisitionPlan.findIndex((row) => row.id === activeAcquisitionId);
  }, [sortedAcquisitionPlan, activeAcquisitionId, selectedSatelliteId]);

  const handleStepAcquisition = useCallback(
    (direction: -1 | 1) => {
      if (sortedAcquisitionPlan.length === 0) return;

      if (currentGlobalAcquisitionIndex === -1) {
        void handleSelectNextAcquisition();
        return;
      }

      const targetIndex = currentGlobalAcquisitionIndex + direction;
      if (targetIndex < 0 || targetIndex >= sortedAcquisitionPlan.length) {
        return;
      }

      const targetRow = sortedAcquisitionPlan[targetIndex];
      selectAcquisitionAndOpenPanel(targetRow);
    },
    [sortedAcquisitionPlan, currentGlobalAcquisitionIndex, handleSelectNextAcquisition, selectAcquisitionAndOpenPanel]
  );

  // Close the image popup if the selected acquisition changes to one that is not completed
  useEffect(() => {
    if (
      !activeAcquisitionRow ||
      activeAcquisitionRow.status.toLowerCase() !== 'completed' ||
      !activeAcquisitionRow.acquired_image
    ) {
      setShowImagePopup(false);
    }
  }, [activeAcquisitionRow]);

  const isAcquisitionCompleted =
    Boolean(activeAcquisitionRow) &&
    activeAcquisitionRow!.status.toLowerCase() === 'completed' &&
    Boolean(activeAcquisitionRow!.acquired_image);

  return (
    <div className="app-shell">
      {/* 3D WebGL Globe Background */}
      <GlobeVisualizer
        events={showGeoEvents ? events : []}
        satellites={satellites}
        selectedEvent={showGeoEvents ? selectedEvent : null}
        selectedSatelliteId={selectedSatelliteId}
        selectedAcquisition={activeSatellite ? activeAcquisitionRow : null}
        acquisitionFocusKey={acquisitionFocusKey}
        trackSelectedSatellite={trackSelectedSatellite}
        onSelectEvent={(ev) => {
          setSelectedEvent(ev);
          setAutoRotate(false);
        }}
        onSelectSatellite={(sat) => {
          setSelectedSatelliteId(sat.id);
        }}
        onFocusAcquisition={() => {
          setAutoRotate(false);
        }}
        isPickingLocation={isPickingGlobeLocation}
        onPickLocation={(coords) => {
          setRequestLatitude(coords.lat.toFixed(4));
          setRequestLongitude(coords.lng.toFixed(4));
          setIsPickingGlobeLocation(false);
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

          <div
            className={`status-pill ${health?.status === 'ok' ? 'online' : 'offline'}`}
            title={
              health?.status === 'ok'
                ? 'Backend API, PostgreSQL, and NATS JetStream are online'
                : 'Connecting to backend services...'
            }
          >
            <Activity size={14} />
            <span>STATUS: {health?.status === 'ok' ? 'ONLINE' : 'DEGRADED'}</span>
          </div>

          <button
            type="button"
            className={`hud-btn request-image-btn ${showRequestImageDialog ? 'active' : ''}`}
            onClick={() => {
              const nextOpen = !showRequestImageDialog;
              setShowRequestImageDialog(nextOpen);
              if (!nextOpen) {
                setIsPickingGlobeLocation(false);
              }
            }}
            title="Open dialog to request a new satellite image capture"
          >
            <Camera size={15} />
            <span>Request Image</span>
          </button>

          <button
            type="button"
            className={`hud-btn see-plan-btn ${showAcquisitionPlanWindow ? 'active' : ''}`}
            onClick={() => {
              const nextOpen = !showAcquisitionPlanWindow;
              setShowAcquisitionPlanWindow(nextOpen);
              if (nextOpen) {
                void handleRefreshFullAcquisitionPlan();
              }
            }}
            title="Open floating Acquisition Plan table sorted by time and filterable by user"
          >
            <ClipboardList size={15} />
            <span>See Acquisition Plan</span>
          </button>

          <div className="acq-nav-group">
            <button
              type="button"
              className="hud-btn acq-step-btn"
              onClick={() => handleStepAcquisition(-1)}
              disabled={
                sortedAcquisitionPlan.length === 0 ||
                (currentGlobalAcquisitionIndex !== -1 && currentGlobalAcquisitionIndex <= 0)
              }
              title="Jump to previous acquisition in chronological order"
              aria-label="Previous acquisition in time"
            >
              <ChevronLeft size={15} />
            </button>

            <button
              type="button"
              className="hud-btn next-acq-btn"
              onClick={handleSelectNextAcquisition}
              title="Find the acquisition closest to current real time (UTC) and open it in the Satellite Info Panel"
            >
              <Crosshair size={15} />
              <span>Next Acquisition</span>
            </button>

            <button
              type="button"
              className="hud-btn acq-step-btn"
              onClick={() => handleStepAcquisition(1)}
              disabled={
                sortedAcquisitionPlan.length === 0 ||
                (currentGlobalAcquisitionIndex !== -1 &&
                  currentGlobalAcquisitionIndex >= sortedAcquisitionPlan.length - 1)
              }
              title="Jump to next acquisition in chronological order"
              aria-label="Next acquisition in time"
            >
              <ChevronRight size={15} />
            </button>
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

      {/* Draggable Floating Request Image Dialog */}
      {showRequestImageDialog && (
        <DraggablePanel
          className="request-image-dialog glass-card"
          initialPosition={{ x: 430, y: 96 }}
          ariaLabel="Request Image Acquisition Dialog"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              <Camera size={16} className="accent-cyan" />
              <span className="tooltip-tag">REQUEST IMAGE ACQUISITION</span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => {
                  setShowRequestImageDialog(false);
                  setIsPickingGlobeLocation(false);
                }}
                aria-label="Close request image dialog"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <form
            className="request-image-form"
            onSubmit={(e) => {
              e.preventDefault();
              // Action on submit not implemented yet per instructions
            }}
          >
            {/* 1. Longitude & Latitude + Pick on Globe Button */}
            <div className="req-section">
              <span className="req-section-label">TARGET LOCATION (LONGITUDE & LATITUDE)</span>
              <div className="req-coords-row">
                <div className="field-group">
                  <label htmlFor="req-lng-input">Longitude (°)</label>
                  <input
                    id="req-lng-input"
                    type="number"
                    step="0.0001"
                    min="-180"
                    max="180"
                    value={requestLongitude}
                    onChange={(e) => setRequestLongitude(e.target.value)}
                    required
                  />
                </div>
                <div className="field-group">
                  <label htmlFor="req-lat-input">Latitude (°)</label>
                  <input
                    id="req-lat-input"
                    type="number"
                    step="0.0001"
                    min="-90"
                    max="90"
                    value={requestLatitude}
                    onChange={(e) => setRequestLatitude(e.target.value)}
                    required
                  />
                </div>
                <button
                  type="button"
                  className={`pick-globe-btn ${isPickingGlobeLocation ? 'active' : ''}`}
                  onClick={() => setIsPickingGlobeLocation((prev) => !prev)}
                  title="Click on the 3D globe to select target longitude and latitude"
                >
                  <MapPin size={14} />
                  <span>{isPickingGlobeLocation ? 'Click Globe...' : 'Pick on Globe'}</span>
                </button>
              </div>
              {isPickingGlobeLocation && (
                <div className="pick-globe-hint">
                  Click any location on the 3D globe to set the coordinates.
                </div>
              )}
            </div>

            {/* 2. Predefined Square Area Size Dropdown */}
            <div className="req-section">
              <label htmlFor="req-area-size-select" className="req-section-label">
                CAPTURE AREA SIZE (SQUARE FOOTPRINT)
              </label>
              <select
                id="req-area-size-select"
                className="req-select"
                value={requestAreaSizeKm}
                onChange={(e) => setRequestAreaSizeKm(Number(e.target.value))}
              >
                <option value={5}>5 × 5 km (25 km² — High Detail)</option>
                <option value={10}>10 × 10 km (100 km²)</option>
                <option value={15}>15 × 15 km (225 km²)</option>
                <option value={25}>25 × 25 km (625 km² — Standard)</option>
                <option value={35}>35 × 35 km (1,225 km²)</option>
                <option value={50}>50 × 50 km (2,500 km² — Wide Swath)</option>
              </select>
            </div>

            {/* 3. Preferred Capture Time */}
            <div className="req-section">
              <span className="req-section-label">PREFERRED CAPTURE TIME</span>
              <div className="req-time-options">
                <label
                  className={`req-radio-option ${requestTimeMode === 'ASAP' ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="requestTimeMode"
                    value="ASAP"
                    checked={requestTimeMode === 'ASAP'}
                    onChange={() => setRequestTimeMode('ASAP')}
                  />
                  <span>As soon as possible</span>
                </label>

                <label
                  className={`req-radio-option ${requestTimeMode === 'ABSOLUTE' ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="requestTimeMode"
                    value="ABSOLUTE"
                    checked={requestTimeMode === 'ABSOLUTE'}
                    onChange={() => setRequestTimeMode('ABSOLUTE')}
                  />
                  <span>Absolute time (UTC)</span>
                </label>
              </div>

              {requestTimeMode === 'ABSOLUTE' && (
                <div className="field-group req-datetime-group">
                  <label htmlFor="req-datetime-input">Target Capture Timestamp (UTC)</label>
                  <input
                    id="req-datetime-input"
                    type="datetime-local"
                    step="1"
                    value={requestAbsoluteTime}
                    onChange={(e) => setRequestAbsoluteTime(e.target.value)}
                    required
                  />
                </div>
              )}
            </div>

            {/* 4. Submit Request Button */}
            <button type="submit" className="submit-btn req-submit-btn">
              <Camera size={15} />
              <span>Submit Request</span>
            </button>
          </form>
        </DraggablePanel>
      )}

      {/* Draggable Floating Acquisition Plan Window */}
      {showAcquisitionPlanWindow && (
        <DraggablePanel
          className="acquisition-plan-window glass-card"
          initialPosition={{ x: 24, y: 96 }}
          ariaLabel="Acquisition Plan Window"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              <ClipboardList size={16} className="accent-cyan" />
              <span className="tooltip-tag">
                GLOBAL ACQUISITION PLAN ({filteredAcquisitionPlan.length} ROWS)
              </span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setShowAcquisitionPlanWindow(false)}
                aria-label="Close acquisition plan window"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="acq-plan-filter-bar">
            <label htmlFor="acq-user-filter-select" className="acq-filter-label">
              <UserIcon size={13} />
              <span>Filter by User:</span>
            </label>
            <select
              id="acq-user-filter-select"
              className="acq-user-filter-select"
              value={planUserFilter}
              onChange={(e) => setPlanUserFilter(e.target.value)}
            >
              <option value="ALL">All Users ({sortedAcquisitionPlan.length})</option>
              {users.map((u) => {
                const count = sortedAcquisitionPlan.filter(
                  (r) => r.user_id === u.id || getUserName(r.user_id) === u.name
                ).length;
                return (
                  <option key={u.id} value={u.id}>
                    {u.name} ({count})
                  </option>
                );
              })}
            </select>
          </div>

          <div className="acq-plan-list-container">
            {filteredAcquisitionPlan.length === 0 ? (
              <div className="acq-empty">No acquisition plan rows match the selected user filter.</div>
            ) : (
              filteredAcquisitionPlan.map((row, idx) => {
                const isSelected = activeSatellite?.id === row.satellite_id && activeAcquisitionRow?.id === row.id;
                const satCfg = satellites.find((s) => s.id === row.satellite_id);
                const satColor = satCfg ? getSatelliteColor(satCfg) : '#38bdf8';
                const shortSat = row.satellite_id.slice(-4).toUpperCase();
                const utcStr = formatUtcTimestamp(new Date(row.acquisition_timestamp).getTime());
                const sizeKm = (row.width_m / 1000).toFixed(1);
                const userName = getUserName(row.user_id);

                return (
                  <div
                    key={row.id}
                    className={`acq-plan-list-item ${isSelected ? 'selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectAcquisitionAndOpenPanel(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        selectAcquisitionAndOpenPanel(row);
                      }
                    }}
                  >
                    <div className="acq-list-item-top">
                      <div className="acq-list-sat-group">
                        <span className="acq-list-index">#{idx + 1}</span>
                        <span
                          className="acq-list-sat-dot"
                          style={{ backgroundColor: satColor, boxShadow: `0 0 8px ${satColor}` }}
                        />
                        <span className="acq-list-sat-code">SAT-{shortSat}</span>
                        <span className="acq-list-user-pill">{userName}</span>
                      </div>
                      <span className={`acq-status-badge ${row.status.toLowerCase()}`}>
                        {row.status}
                      </span>
                    </div>
                    <div className="acq-list-item-bottom">
                      <span className="acq-list-time">{utcStr}</span>
                      <span className="acq-list-coords">
                        {sizeKm}×{sizeKm} km • ({row.center_latitude_deg.toFixed(2)}°,{' '}
                        {row.center_longitude_deg.toFixed(2)}°)
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DraggablePanel>
      )}

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
                onClick={() => {
                  setSelectedSatelliteId(null);
                  setShowImagePopup(false);
                }}
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

          {/* Satellite Image Acquisition Plan Dropdown, Details & Action Buttons */}
          <div className="acq-plan-section">
            <div className="acq-plan-header">
              <span className="label">
                ACQUISITION PLAN ({selectedSatelliteAcquisitions.length} SCHEDULED)
              </span>
            </div>
            {selectedSatelliteAcquisitions.length > 0 ? (
              <>
                <select
                  aria-label="Select Acquisition Plan Row"
                  className="acq-plan-select"
                  value={activeAcquisitionRow?.id || ''}
                  onChange={(e) => {
                    setSelectedAcquisitionId(e.target.value);
                    setAcquisitionFocusKey((prev) => prev + 1);
                  }}
                  style={{ borderColor: `${activeSatellite.color}55` }}
                >
                  {selectedSatelliteAcquisitions.map((acq, idx) => {
                    const utcShort = formatUtcTimestamp(new Date(acq.acquisition_timestamp).getTime());
                    const sizeKm = (acq.width_m / 1000).toFixed(1);
                    return (
                      <option key={acq.id} value={acq.id}>
                        #{idx + 1} • {utcShort} • {sizeKm}×{sizeKm} km [{acq.status}]
                      </option>
                    );
                  })}
                </select>
                {activeAcquisitionRow && (
                  <>
                    <div
                      className="acq-plan-details"
                      role="button"
                      tabIndex={0}
                      title="Click to center and zoom over this acquisition area"
                      onClick={() => setAcquisitionFocusKey((prev) => prev + 1)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setAcquisitionFocusKey((prev) => prev + 1);
                        }
                      }}
                    >
                      <div>
                        <span className="label">PLANNED TIME</span>
                        <span className="mono">
                          {formatUtcTimestamp(new Date(activeAcquisitionRow.acquisition_timestamp).getTime())}
                        </span>
                      </div>
                      <div>
                        <span className="label">STATUS / DURATION</span>
                        <span className="mono">
                          <span className={`acq-status-badge ${activeAcquisitionRow.status.toLowerCase()}`}>
                            {activeAcquisitionRow.status}
                          </span>{' '}
                          • {activeAcquisitionRow.duration_seconds}s
                        </span>
                      </div>
                      <div>
                        <span className="label">TARGET CENTER (LAT, LNG)</span>
                        <span className="mono">
                          {activeAcquisitionRow.center_latitude_deg.toFixed(3)}°,{' '}
                          {activeAcquisitionRow.center_longitude_deg.toFixed(3)}°
                        </span>
                      </div>
                      <div>
                        <span className="label">CAPTURE AREA (W × H)</span>
                        <span className="mono">
                          {(activeAcquisitionRow.width_m / 1000).toFixed(1)} ×{' '}
                          {(activeAcquisitionRow.height_m / 1000).toFixed(1)} km
                        </span>
                      </div>
                      <div className="full-span-row">
                        <span className="label">USER</span>
                        <span className="mono user-badge-value">
                          {getUserName(activeAcquisitionRow.user_id)}
                        </span>
                      </div>
                    </div>

                    <div className="acq-actions-row">
                      <button
                        type="button"
                        className={`acq-action-btn show-image ${isAcquisitionCompleted ? 'enabled' : ''}`}
                        onClick={() => {
                          if (isAcquisitionCompleted) {
                            setShowImagePopup(true);
                          }
                        }}
                        disabled={!isAcquisitionCompleted}
                        title={
                          isAcquisitionCompleted
                            ? 'Display acquired 256×256 satellite image popup'
                            : 'Image available once acquisition status is Completed'
                        }
                      >
                        <ImageIcon size={13} />
                        <span>Show Image</span>
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="acq-empty">No acquisitions scheduled for this satellite.</div>
            )}
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

      {/* Draggable Acquired 256x256 Satellite Image Popup */}
      {showImagePopup && activeSatellite && activeAcquisitionRow && activeAcquisitionRow.acquired_image && (
        <DraggablePanel
          className="acquired-image-popup"
          initialPosition={{ x: Math.max(20, window.innerWidth - 680), y: 315 }}
          style={{ borderColor: activeSatellite.color }}
          ariaLabel="Acquired Satellite Image Popup"
        >
          <div className="tooltip-header drag-handle-header">
            <span className="tooltip-tag" style={{ color: activeSatellite.color }}>
              ACQUIRED SATELLITE IMAGERY (256×256)
            </span>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setShowImagePopup(false)}
                aria-label="Close acquired image popup"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="acquired-image-frame">
            <img
              src={activeAcquisitionRow.acquired_image}
              alt={`Acquired satellite capture at ${activeAcquisitionRow.center_latitude_deg.toFixed(3)}, ${activeAcquisitionRow.center_longitude_deg.toFixed(3)}`}
              width={256}
              height={256}
              className="acquired-image-view"
            />
          </div>

          <div className="acquired-image-meta">
            <div>
              <span className="label">CENTER (LAT, LNG)</span>
              <span className="mono">
                {activeAcquisitionRow.center_latitude_deg.toFixed(4)}°,{' '}
                {activeAcquisitionRow.center_longitude_deg.toFixed(4)}°
              </span>
            </div>
            <div>
              <span className="label">SWATH AREA</span>
              <span className="mono">
                {(activeAcquisitionRow.width_m / 1000).toFixed(1)} ×{' '}
                {(activeAcquisitionRow.height_m / 1000).toFixed(1)} km
              </span>
            </div>
            <div className="full-span">
              <span className="label">ACQUISITION TIMESTAMP</span>
              <span className="mono">
                {formatUtcTimestamp(new Date(activeAcquisitionRow.acquisition_timestamp).getTime())}
              </span>
            </div>
          </div>
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
