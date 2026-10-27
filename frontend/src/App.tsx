import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Satellite,
  Activity,
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
  ChevronDown,
  ClipboardList,
  ListOrdered,
  Layers,
  BarChart3,
  LineChart,
  User as UserIcon,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Play,
  Square,
  X,
} from 'lucide-react';
import { GlobeVisualizer } from './components/GlobeVisualizer';
import {
  SatelliteConfig,
  SatellitePosition,
  UserRow,
  AcquisitionPlanRow,
  AcquisitionRequestQueueItem,
  AcquisitionRequestEvaluationResult,
  AcquisitionCancelEventPayload,
  HealthResponse,
  fetchHealth,
  fetchSatellites,
  updateSatelliteStatus,
  fetchUsers,
  initializeAcquisitionPlan,
  stopAcquisitionPlan,
  fetchAcquisitionPlan,
  fetchAcquisitionById,
  fetchAcquisitionRequestsQueue,
  submitAcquisitionRequest,
  confirmReservedAcquisition,
  cancelReservedAcquisition,
  markAcquisitionFailed,
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
        'button, input, select, textarea, a, label, .acq-plan-list-container, .acq-plan-list-item, .acq-timeline-container, .acq-timeline-dot, .acq-sat-row-label'
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
  const [satellites, setSatellites] = useState<SatelliteConfig[]>([]);
  const [users, setUsers] = useState<UserRow[]>([
    { id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01', name: 'system' },
    { id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02', name: 'demo' },
  ]);
  const [acquisitionPlan, setAcquisitionPlan] = useState<AcquisitionPlanRow[]>([]);
  const [isPlanRunning, setIsPlanRunning] = useState<boolean>(false);
  const [togglingPlanRunState, setTogglingPlanRunState] = useState<boolean>(false);
  const [selectedAcquisitionId, setSelectedAcquisitionId] = useState<string | null>(null);
  const [acquisitionFocusKey, setAcquisitionFocusKey] = useState<number>(0);
  const [showImagePopup, setShowImagePopup] = useState<boolean>(false);
  const [showAcquisitionPlanWindow, setShowAcquisitionPlanWindow] = useState<boolean>(false);
  const [planWindowMode, setPlanWindowMode] = useState<'list' | 'timeline'>('list');
  const [timelineZoom, setTimelineZoom] = useState<number>(1);
  const timelineStartAnchorRef = useRef<number | null>(null);
  const [planUserFilter, setPlanUserFilter] = useState<string>('ALL');

  // Top bar dropdown & Stats windows state
  const [openTopDropdown, setOpenTopDropdown] = useState<'image_requests' | 'stats' | null>(null);
  const [showStatusStatsWindow, setShowStatusStatsWindow] = useState<boolean>(false);
  const [showTimelineStatsWindow, setShowTimelineStatsWindow] = useState<boolean>(false);
  const [statsHistory, setStatsHistory] = useState<
    Array<{
      timeMs: number;
      completed: number;
      failed: number;
      reprogrammed: number;
      failedOrReprogrammed: number;
    }>
  >(() => [
    {
      timeMs: Date.now(),
      completed: 0,
      failed: 0,
      reprogrammed: 0,
      failedOrReprogrammed: 0,
    },
  ]);

  // Acquisition Requests Queue Window state
  const [requestsQueue, setRequestsQueue] = useState<AcquisitionRequestQueueItem[]>([]);
  const [showRequestsQueueWindow, setShowRequestsQueueWindow] = useState<boolean>(false);
  const [queueOwnerFilter, setQueueOwnerFilter] = useState<string>('ALL');

  // Batch Requests Dialog state
  const [showBatchRequestsDialog, setShowBatchRequestsDialog] = useState<boolean>(false);
  const [batchRequestCount, setBatchRequestCount] = useState<string>('5');
  const [submittingBatchRequests, setSubmittingBatchRequests] = useState<boolean>(false);
  const [batchSubmitError, setBatchSubmitError] = useState<string | null>(null);

  // Request Image Dialog state
  const [showRequestImageDialog, setShowRequestImageDialog] = useState<boolean>(false);
  const [reprogramSourceAcquisitionId, setReprogramSourceAcquisitionId] = useState<string | null>(
    null
  );
  const [markingFailed, setMarkingFailed] = useState<boolean>(false);
  const [isPickingGlobeLocation, setIsPickingGlobeLocation] = useState<boolean>(false);
  const [requestLongitude, setRequestLongitude] = useState<string>('-3.7038');
  const [requestLatitude, setRequestLatitude] = useState<string>('40.4168');
  const [requestAreaSizeKm, setRequestAreaSizeKm] = useState<number>(25);
  const [requestTimeMode, setRequestTimeMode] = useState<'ASAP' | 'ABSOLUTE'>('ASAP');
  const [requestAbsoluteTime, setRequestAbsoluteTime] = useState<string>(() =>
    new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 16)
  );
  const [submittingImageRequest, setSubmittingImageRequest] = useState<boolean>(false);
  const [requestSubmitError, setRequestSubmitError] = useState<string | null>(null);
  const [pendingEvaluationsCount, setPendingEvaluationsCount] = useState<number>(0);
  const [evaluationPopupResult, setEvaluationPopupResult] =
    useState<AcquisitionRequestEvaluationResult | null>(null);
  const [processingEvaluationAction, setProcessingEvaluationAction] = useState<boolean>(false);
  const [cancelNotification, setCancelNotification] =
    useState<AcquisitionCancelEventPayload | null>(null);
  const [selectedSatelliteId, setSelectedSatelliteId] = useState<string | null>(null);
  const [trackSelectedSatellite, setTrackSelectedSatellite] = useState<boolean>(false);
  const [confirmSatStatusTarget, setConfirmSatStatusTarget] = useState<SatellitePosition | null>(
    null
  );
  const [updatingSatStatus, setUpdatingSatStatus] = useState<boolean>(false);
  const [satStatusToast, setSatStatusToast] = useState<{
    message: string;
    type: 'disabled' | 'restored';
  } | null>(null);
  const satStatusToastTimerRef = useRef<number | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);

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

  // Close top-bar dropdown menus when clicking outside
  useEffect(() => {
    if (!openTopDropdown) return;
    const handleOutsideClick = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest('.hud-dropdown-wrapper')) {
        setOpenTopDropdown(null);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    return () => document.removeEventListener('pointerdown', handleOutsideClick);
  }, [openTopDropdown]);

  // Record live time-series history of Completed vs Failed/Reprogrammed acquisitions
  const recordStatsSnapshot = useCallback((planRows: AcquisitionPlanRow[]) => {
    let completed = 0;
    let failed = 0;
    let reprogrammed = 0;
    for (const r of planRows) {
      const st = (r.status || '').toLowerCase();
      if (st === 'completed') completed++;
      else if (st === 'failed') failed++;
      else if (st === 'reprogrammed') reprogrammed++;
    }
    const failedOrReprogrammed = failed + reprogrammed;
    const now = Date.now();

    setStatsHistory((prev) => {
      if (prev.length === 0) {
        return [{ timeMs: now, completed, failed, reprogrammed, failedOrReprogrammed }];
      }
      const last = prev[prev.length - 1];
      // If counts changed or at least 2 seconds elapsed, append a new point (keep up to 180 points)
      if (
        last.completed !== completed ||
        last.failed !== failed ||
        last.reprogrammed !== reprogrammed ||
        now - last.timeMs >= 2000
      ) {
        const next = [
          ...prev,
          { timeMs: now, completed, failed, reprogrammed, failedOrReprogrammed },
        ];
        return next.length > 180 ? next.slice(next.length - 180) : next;
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    recordStatsSnapshot(acquisitionPlan);
  }, [acquisitionPlan, recordStatsSnapshot]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      recordStatsSnapshot(acquisitionPlan);
    }, 2000);
    return () => window.clearInterval(interval);
  }, [acquisitionPlan, recordStatsSnapshot]);

  const loadData = useCallback(async () => {
    try {
      const healthRes = await fetchHealth().catch(() => null);
      if (healthRes) {
        setHealth(healthRes);
      }
    } catch {
      // Ignore transient health polling errors
    }
  }, []);

  // Read satellite fleet, users, and any already-active acquisition plan at startup (does not auto-start a new plan)
  const startupInitRef = useRef<boolean>(false);
  useEffect(() => {
    if (startupInitRef.current) return;
    startupInitRef.current = true;

    Promise.all([
      fetchSatellites(),
      fetchAcquisitionPlan().catch(() => ({ data: [], total: 0 })),
      fetchUsers().catch(() => null),
      fetchAcquisitionRequestsQueue().catch(() => null),
    ])
      .then(([satRes, planRes, usersRes, queueRes]) => {
        setSatellites(satRes.data);
        setAcquisitionPlan(planRes.data);
        setIsPlanRunning(planRes.data.length > 0);
        if (usersRes && usersRes.data.length > 0) {
          setUsers(usersRes.data);
        }
        if (queueRes) {
          setRequestsQueue(queueRes.data);
        }
      })
      .catch((err) => console.error('Failed to load satellite fleet or acquisition plan:', err));
  }, []);

  useEffect(() => {
    if (acquisitionPlan.length > 0 && !isPlanRunning) {
      setIsPlanRunning(true);
    }
  }, [acquisitionPlan.length, isPlanRunning]);

  const handleTogglePlanRunState = async () => {
    if (togglingPlanRunState) return;
    setTogglingPlanRunState(true);
    try {
      if (!isPlanRunning) {
        const [planRes, satRes] = await Promise.all([
          initializeAcquisitionPlan(),
          fetchSatellites(),
        ]);
        timelineStartAnchorRef.current = null;
        setSatellites(satRes.data);
        setAcquisitionPlan(planRes.data);
        setRequestsQueue([]);
        setEvaluationPopupResult(null);
        setCancelNotification(null);
        setStatsHistory([
          {
            timeMs: Date.now(),
            completed: 0,
            failed: 0,
            reprogrammed: 0,
            failedOrReprogrammed: 0,
          },
        ]);
        setIsPlanRunning(true);
      } else {
        await stopAcquisitionPlan();
        const satRes = await fetchSatellites();
        timelineStartAnchorRef.current = null;
        setSatellites(satRes.data);
        setAcquisitionPlan([]);
        setRequestsQueue([]);
        setEvaluationPopupResult(null);
        setCancelNotification(null);
        setShowImagePopup(false);
        setIsPlanRunning(false);
      }
    } catch (err) {
      console.error('Failed to toggle acquisition plan execution state:', err);
    } finally {
      setTogglingPlanRunState(false);
    }
  };

  // Subscribe to real-time acquisition status updates, request evaluations, cancellations, and queue changes via Server-Sent Events (NATS JetStream push)
  useEffect(() => {
    const unsubscribe = subscribeToAcquisitionUpdates(
      (updatedRow) => {
        setAcquisitionPlan((prev) => {
          const exists = prev.some((r) => r.id === updatedRow.id);
          if (!exists) return [...prev, updatedRow];
          return prev.map((r) => (r.id === updatedRow.id ? updatedRow : r));
        });
      },
      (evaluation) => {
        setPendingEvaluationsCount((c) => Math.max(0, c - 1));
        setCancelNotification(null);
        setEvaluationPopupResult(evaluation);
        // Also highlight the newly reserved acquisition on the 3D globe & Satellite Info Panel
        setSelectedSatelliteId(evaluation.acquisition.satellite_id);
        setSelectedAcquisitionId(evaluation.acquisition.id);
        setAcquisitionFocusKey((prev) => prev + 1);
      },
      (cancelEvent) => {
        // Remove the canceled Reserved acquisition from the plan
        setAcquisitionPlan((prev) =>
          prev.filter((r) => r.id !== cancelEvent.acquisition_id)
        );
        // Close the Confirmation dialog if it was open for this acquisition
        setEvaluationPopupResult((prev) =>
          prev && prev.acquisition.id === cancelEvent.acquisition_id ? null : prev
        );
        // Inform the user if the backend automatically canceled the reservation due to timeout or reaching capture time
        if (cancelEvent.reason !== 'user_canceled') {
          setCancelNotification(cancelEvent);
        }
      },
      (updatedQueue) => {
        setRequestsQueue(updatedQueue);
      },
      (updatedSat) => {
        setSatellites((prev) =>
          prev.map((s) => (s.id === updatedSat.id ? { ...s, status: updatedSat.status } : s))
        );
        // Refresh the full acquisition plan so reprogrammed or reassigned items are reflected immediately
        void fetchAcquisitionPlan()
          .then((res) => setAcquisitionPlan(res.data))
          .catch((err) => console.error('Failed to refresh acquisition plan after satellite status change:', err));

        const shortCode = updatedSat.id.slice(-4).toUpperCase();
        const isNowDisabled = updatedSat.status === 'disabled';
        const reprogrammedCount = updatedSat.reprogrammed_count ?? 0;
        const reassignedCount = updatedSat.reassigned_count ?? 0;

        if (satStatusToastTimerRef.current) {
          window.clearTimeout(satStatusToastTimerRef.current);
        }
        setSatStatusToast({
          message: isNowDisabled
            ? `Satellite SAT-${shortCode} has been deactivated. ${reprogrammedCount} acquisition ${
                reprogrammedCount === 1 ? 'item has' : 'items have'
              } been reprogrammed.`
            : `Satellite SAT-${shortCode} restored. ${reassignedCount} acquisition ${
                reassignedCount === 1 ? 'item has' : 'items have'
              } been reassigned to this satellite.`,
          type: isNowDisabled ? 'disabled' : 'restored',
        });
        satStatusToastTimerRef.current = window.setTimeout(() => {
          setSatStatusToast(null);
          satStatusToastTimerRef.current = null;
        }, 5500);
      }
    );
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

  const handleRefreshRequestsQueue = useCallback(async () => {
    try {
      const latestQueueRes = await fetchAcquisitionRequestsQueue();
      setRequestsQueue(latestQueueRes.data);
    } catch (err) {
      console.error('Failed to refresh acquisition requests queue:', err);
    }
  }, []);

  const handleSubmitImageRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingImageRequest(true);
    setRequestSubmitError(null);

    try {
      const lng = parseFloat(requestLongitude);
      const lat = parseFloat(requestLatitude);
      const sizeMeters = requestAreaSizeKm * 1000;

      let requestedTimestampIso: string | null = null;
      if (requestTimeMode === 'ABSOLUTE') {
        const normalizedIso = requestAbsoluteTime.endsWith('Z')
          ? requestAbsoluteTime
          : requestAbsoluteTime.length === 16
          ? `${requestAbsoluteTime}:00Z`
          : `${requestAbsoluteTime}Z`;
        requestedTimestampIso = new Date(normalizedIso).toISOString();
      }

      await submitAcquisitionRequest({
        longitude: lng,
        latitude: lat,
        width_m: sizeMeters,
        height_m: sizeMeters,
        time_mode: requestTimeMode,
        requested_timestamp: requestedTimestampIso,
        confirmation_mode: 'manual',
        reprogrammed_from_id: reprogramSourceAcquisitionId,
      });

      setPendingEvaluationsCount((c) => c + 1);
      setReprogramSourceAcquisitionId(null);
      setShowRequestImageDialog(false);
      setIsPickingGlobeLocation(false);
    } catch (err: any) {
      setRequestSubmitError(err.message || 'Failed to submit acquisition request');
    } finally {
      setSubmittingImageRequest(false);
    }
  };

  const handleSubmitBatchRequests = async (e: React.FormEvent) => {
    e.preventDefault();
    const count = Math.max(1, Math.min(50, parseInt(batchRequestCount, 10) || 1));
    setSubmittingBatchRequests(true);
    setBatchSubmitError(null);

    const predefinedSizesKm = [5, 10, 15, 25, 35, 50];

    try {
      for (let i = 0; i < count; i++) {
        const randomLng = Number((Math.random() * 360 - 180).toFixed(4));
        const randomLat = Number((Math.random() * 150 - 75).toFixed(4));
        const sizeKm =
          predefinedSizesKm[Math.floor(Math.random() * predefinedSizesKm.length)];
        const sizeMeters = sizeKm * 1000;

        await submitAcquisitionRequest({
          longitude: randomLng,
          latitude: randomLat,
          width_m: sizeMeters,
          height_m: sizeMeters,
          time_mode: 'ASAP',
          requested_timestamp: null,
          confirmation_mode: 'auto',
        });
      }

      setShowBatchRequestsDialog(false);
    } catch (err: any) {
      setBatchSubmitError(err.message || 'Failed to submit batch acquisition requests');
    } finally {
      setSubmittingBatchRequests(false);
    }
  };

  const handleConfirmReservation = async () => {
    if (!evaluationPopupResult || processingEvaluationAction) return;
    const acqId = evaluationPopupResult.acquisition.id;
    setProcessingEvaluationAction(true);
    try {
      const res = await confirmReservedAcquisition(acqId);
      setAcquisitionPlan((prev) =>
        prev.map((row) => (row.id === acqId ? res.data : row))
      );
      setEvaluationPopupResult(null);
    } catch (err) {
      console.error('Failed to confirm reserved acquisition:', err);
    } finally {
      setProcessingEvaluationAction(false);
    }
  };

  const handleCancelReservation = async () => {
    if (!evaluationPopupResult || processingEvaluationAction) return;
    const acqId = evaluationPopupResult.acquisition.id;
    setProcessingEvaluationAction(true);
    try {
      await cancelReservedAcquisition(acqId);
      setAcquisitionPlan((prev) => prev.filter((row) => row.id !== acqId));
      setEvaluationPopupResult(null);
    } catch (err) {
      console.error('Failed to cancel reserved acquisition:', err);
    } finally {
      setProcessingEvaluationAction(false);
    }
  };

  const handleMarkAcquisitionFailed = async () => {
    if (!activeAcquisitionRow || markingFailed) return;
    const acqId = activeAcquisitionRow.id;
    setMarkingFailed(true);
    try {
      const res = await markAcquisitionFailed(acqId);
      setAcquisitionPlan((prev) =>
        prev.map((row) => (row.id === acqId ? res.data : row))
      );
      setShowImagePopup(false);
    } catch (err) {
      console.error('Failed to mark acquisition as failed:', err);
    } finally {
      setMarkingFailed(false);
    }
  };

  const handleOpenReprogramDialog = useCallback((row: AcquisitionPlanRow) => {
    setReprogramSourceAcquisitionId(row.id);
    setRequestLongitude(row.center_longitude_deg.toFixed(4));
    setRequestLatitude(row.center_latitude_deg.toFixed(4));
    const sizeKm = Math.max(5, Math.round(row.width_m / 1000));
    setRequestAreaSizeKm(sizeKm);
    setRequestTimeMode('ASAP');
    setRequestSubmitError(null);
    setIsPickingGlobeLocation(false);
    setShowRequestImageDialog(true);
  }, []);

  const handleConfirmSatelliteStatusChange = async () => {
    if (!confirmSatStatusTarget || updatingSatStatus) return;
    const currentStatus = (confirmSatStatusTarget.status || 'active').toLowerCase();
    const nextStatus: 'active' | 'disabled' =
      currentStatus === 'disabled' ? 'active' : 'disabled';
    setUpdatingSatStatus(true);
    try {
      await updateSatelliteStatus(confirmSatStatusTarget.id, nextStatus);
      setConfirmSatStatusTarget(null);
    } catch (err) {
      console.error('Failed to update satellite status:', err);
    } finally {
      setUpdatingSatStatus(false);
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
      const st = row.status.toLowerCase();
      return (
        acqMs + halfDurMs >= nowRealMs &&
        st !== 'completed' &&
        st !== 'failed' &&
        st !== 'reprogrammed'
      );
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

  // Stable timeline bounds for the Full Timeline mode of the Global Acquisition Plan window.
  // Anchors startMs so adding later acquisitions extends endMs (and horizontal scroll width)
  // without altering the horizontal time scale (zoom factor).
  const timelineBounds = React.useMemo(() => {
    const nowSnap = Date.now();
    const sourcePlan =
      filteredAcquisitionPlan.length > 0 ? filteredAcquisitionPlan : sortedAcquisitionPlan;

    if (sourcePlan.length === 0) {
      const startMs =
        timelineStartAnchorRef.current ?? Math.floor((nowSnap - 30_000) / 60_000) * 60_000;
      const endMs = Math.ceil((startMs + 31 * 60_000) / 60_000) * 60_000;
      return { startMs, endMs, spanMs: Math.max(60_000, endMs - startMs) };
    }

    let minAcqMs = Infinity;
    let maxAcqMs = -Infinity;
    for (const row of sourcePlan) {
      const t = new Date(row.acquisition_timestamp).getTime();
      if (t < minAcqMs) minAcqMs = t;
      if (t > maxAcqMs) maxAcqMs = t;
    }

    const candidateStartMs = Math.floor((Math.min(minAcqMs, nowSnap) - 30_000) / 60_000) * 60_000;
    if (
      timelineStartAnchorRef.current === null ||
      candidateStartMs < timelineStartAnchorRef.current ||
      minAcqMs - timelineStartAnchorRef.current > 60 * 60_000
    ) {
      timelineStartAnchorRef.current = candidateStartMs;
    }

    const startMs = timelineStartAnchorRef.current;
    const rawEnd = Math.max(maxAcqMs + 60_000, startMs + 31 * 60_000);
    const endMs = Math.ceil(rawEnd / 60_000) * 60_000;
    return { startMs, endMs, spanMs: Math.max(60_000, endMs - startMs) };
  }, [filteredAcquisitionPlan, sortedAcquisitionPlan]);

  // Pending acquisition requests sorted chronologically by submission time (created_at)
  const sortedRequestsQueue = React.useMemo(() => {
    return [...requestsQueue].sort((a, b) => {
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }, [requestsQueue]);

  // Filtered pending acquisition requests by owner for the "Requests Queue" floating window
  const filteredRequestsQueue = React.useMemo(() => {
    if (queueOwnerFilter === 'ALL') return sortedRequestsQueue;
    const selectedUser = users.find((u) => u.id === queueOwnerFilter || u.name === queueOwnerFilter);
    return sortedRequestsQueue.filter((row) => {
      if (row.user_id && row.user_id === queueOwnerFilter) return true;
      if (selectedUser && getUserName(row.user_id) === selectedUser.name) return true;
      return false;
    });
  }, [sortedRequestsQueue, queueOwnerFilter, users, getUserName]);

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

  const isAcquisitionFailed =
    Boolean(activeAcquisitionRow) &&
    activeAcquisitionRow!.status.toLowerCase() === 'failed';

  return (
    <div className="app-shell">
      {/* 3D WebGL Globe Background */}
      <GlobeVisualizer
        satellites={satellites}
        selectedSatelliteId={selectedSatelliteId}
        selectedAcquisition={
          activeSatellite &&
          activeAcquisitionRow &&
          activeAcquisitionRow.status.toLowerCase() !== 'reprogrammed'
            ? activeAcquisitionRow
            : null
        }
        acquisitionFocusKey={acquisitionFocusKey}
        trackSelectedSatellite={trackSelectedSatellite}
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
            className="status-pill icon-only online clickable-pill"
            role="button"
            tabIndex={0}
            title={`Fleet: ${satellites.length} Satellites — Click to open Satellite Information Panel`}
            aria-label={`Fleet: ${satellites.length} Satellites`}
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
            <Satellite size={15} />
          </div>

          <div
            className={`status-pill icon-only ${health?.status === 'ok' ? 'online' : 'offline'}`}
            title={
              health?.status === 'ok'
                ? 'Status: ONLINE — Backend API, PostgreSQL, and NATS JetStream are online'
                : 'Status: DEGRADED — Connecting to backend services...'
            }
            aria-label={health?.status === 'ok' ? 'Status Online' : 'Status Degraded'}
          >
            <Activity size={15} />
          </div>

          {/* Start / End Acquisition Plan Session Button */}
          <button
            type="button"
            className={`hud-btn plan-session-btn ${isPlanRunning ? 'running' : 'stopped'}`}
            disabled={togglingPlanRunState}
            onClick={handleTogglePlanRunState}
            title={
              isPlanRunning
                ? 'Stop the active acquisition plan and clear background execution timers'
                : 'Initialize and start a new 30-minute acquisition plan session'
            }
          >
            {isPlanRunning ? <Square size={14} /> : <Play size={14} />}
            <span>{togglingPlanRunState ? '...' : isPlanRunning ? 'End' : 'Start'}</span>
          </button>

          {/* Image Requests Dropdown Button (Request Image, Batch Requests, Requests Queue) */}
          <div className="hud-dropdown-wrapper">
            <button
              type="button"
              className={`hud-btn image-requests-dropdown-btn ${
                openTopDropdown === 'image_requests' ||
                showRequestImageDialog ||
                showBatchRequestsDialog ||
                showRequestsQueueWindow
                  ? 'active'
                  : ''
              }`}
              onClick={() =>
                setOpenTopDropdown((prev) =>
                  prev === 'image_requests' ? null : 'image_requests'
                )
              }
              title="Image Requests menu (Request Image, Batch Requests, Requests Queue)"
            >
              <Camera size={15} />
              <span>Image Requests</span>
              {requestsQueue.length > 0 && (
                <span className="queue-count-badge">{requestsQueue.length}</span>
              )}
              <ChevronDown size={14} className="dropdown-caret" />
            </button>

            {openTopDropdown === 'image_requests' && (
              <div className="hud-dropdown-menu glass-card" role="menu">
                <button
                  type="button"
                  className={`hud-dropdown-item ${showRequestImageDialog ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    const nextOpen = !showRequestImageDialog;
                    setShowRequestImageDialog(nextOpen);
                    setReprogramSourceAcquisitionId(null);
                    if (!nextOpen) {
                      setIsPickingGlobeLocation(false);
                    }
                    setOpenTopDropdown(null);
                  }}
                >
                  <Camera size={14} className="dropdown-item-icon emerald" />
                  <span>Request Image</span>
                  {showRequestImageDialog && <span className="dropdown-open-pill">Open</span>}
                </button>

                <button
                  type="button"
                  className={`hud-dropdown-item ${showBatchRequestsDialog ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setShowBatchRequestsDialog((prev) => !prev);
                    setBatchSubmitError(null);
                    setOpenTopDropdown(null);
                  }}
                >
                  <Layers size={14} className="dropdown-item-icon sky" />
                  <span>Batch Requests</span>
                  {showBatchRequestsDialog && <span className="dropdown-open-pill">Open</span>}
                </button>

                <button
                  type="button"
                  className={`hud-dropdown-item ${showRequestsQueueWindow ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    const nextOpen = !showRequestsQueueWindow;
                    setShowRequestsQueueWindow(nextOpen);
                    if (nextOpen) {
                      void handleRefreshRequestsQueue();
                    }
                    setOpenTopDropdown(null);
                  }}
                >
                  <ListOrdered size={14} className="dropdown-item-icon amber" />
                  <span>Requests Queue</span>
                  {requestsQueue.length > 0 && (
                    <span className="queue-count-badge">{requestsQueue.length}</span>
                  )}
                  {showRequestsQueueWindow && <span className="dropdown-open-pill">Open</span>}
                </button>
              </div>
            )}
          </div>

          {/* Stats Dropdown Button (Status Vertical Bar Chart & Completed vs Failed/Reprogrammed Line Chart) */}
          <div className="hud-dropdown-wrapper">
            <button
              type="button"
              className={`hud-btn stats-dropdown-btn ${
                openTopDropdown === 'stats' || showStatusStatsWindow || showTimelineStatsWindow
                  ? 'active'
                  : ''
              }`}
              onClick={() =>
                setOpenTopDropdown((prev) => (prev === 'stats' ? null : 'stats'))
              }
              title="Open Acquisition Plan Statistics charts"
            >
              <BarChart3 size={15} />
              <span>Stats</span>
              <ChevronDown size={14} className="dropdown-caret" />
            </button>

            {openTopDropdown === 'stats' && (
              <div className="hud-dropdown-menu glass-card" role="menu">
                <button
                  type="button"
                  className={`hud-dropdown-item ${showStatusStatsWindow ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setShowStatusStatsWindow((prev) => !prev);
                    setOpenTopDropdown(null);
                  }}
                >
                  <BarChart3 size={14} className="dropdown-item-icon cyan" />
                  <span>Status</span>
                  {showStatusStatsWindow && <span className="dropdown-open-pill">Open</span>}
                </button>

                <button
                  type="button"
                  className={`hud-dropdown-item ${showTimelineStatsWindow ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setShowTimelineStatsWindow((prev) => !prev);
                    setOpenTopDropdown(null);
                  }}
                >
                  <LineChart size={14} className="dropdown-item-icon emerald" />
                  <span>Completed vs Failed / Reprogrammed</span>
                  {showTimelineStatsWindow && <span className="dropdown-open-pill">Open</span>}
                </button>
              </div>
            )}
          </div>

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
        </div>
      </header>

      {/* Draggable Floating Batch Requests Dialog */}
      {showBatchRequestsDialog && (
        <DraggablePanel
          className="batch-requests-dialog glass-card"
          initialPosition={{ x: 460, y: 96 }}
          ariaLabel="Batch Acquisition Requests Dialog"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              <Layers size={16} className="accent-cyan" />
              <span className="tooltip-tag">BATCH ACQUISITION REQUESTS</span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setShowBatchRequestsDialog(false)}
                aria-label="Close batch requests dialog"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <form className="request-image-form" onSubmit={handleSubmitBatchRequests}>
            <div className="req-section">
              <label htmlFor="batch-req-count-input" className="req-section-label">
                NUMBER OF REQUESTS TO ENQUEUE
              </label>
              <input
                id="batch-req-count-input"
                className="batch-count-input"
                type="number"
                min="1"
                max="50"
                step="1"
                value={batchRequestCount}
                onChange={(e) => setBatchRequestCount(e.target.value)}
                required
              />
              <span className="batch-mode-hint">
                Each request is sent with <strong>auto</strong> confirmation,{' '}
                <strong>as soon as possible</strong> capture time, and a random location on the
                globe.
              </span>
            </div>

            {batchSubmitError && <div className="error-banner">{batchSubmitError}</div>}

            <button
              type="submit"
              className="submit-btn req-submit-btn"
              disabled={submittingBatchRequests}
            >
              <Layers size={15} />
              <span>
                {submittingBatchRequests
                  ? 'Sending Batch Requests...'
                  : `Send ${Math.max(1, Math.min(50, parseInt(batchRequestCount, 10) || 1))} Requests`}
              </span>
            </button>
          </form>
        </DraggablePanel>
      )}

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
                  setReprogramSourceAcquisitionId(null);
                  setIsPickingGlobeLocation(false);
                }}
                aria-label="Close request image dialog"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <form className="request-image-form" onSubmit={handleSubmitImageRequest}>
            {reprogramSourceAcquisitionId && (
              <div className="reprogram-source-banner">
                <RotateCcw size={13} />
                <div>
                  <span className="reprogram-source-label">
                    REPROGRAMMING FAILED ACQUISITION ID
                  </span>
                  <span className="reprogram-source-id">{reprogramSourceAcquisitionId}</span>
                </div>
              </div>
            )}

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
                {![5, 10, 15, 25, 35, 50].includes(requestAreaSizeKm) && (
                  <option value={requestAreaSizeKm}>
                    {requestAreaSizeKm} × {requestAreaSizeKm} km (
                    {requestAreaSizeKm * requestAreaSizeKm} km² — Original Failed Area)
                  </option>
                )}
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

            {requestSubmitError && <div className="error-banner">{requestSubmitError}</div>}

            {/* 4. Submit Request Button */}
            <button
              type="submit"
              className="submit-btn req-submit-btn"
              disabled={submittingImageRequest}
            >
              <Camera size={15} />
              <span>{submittingImageRequest ? 'Enqueuing Request...' : 'Submit Request'}</span>
            </button>
          </form>
        </DraggablePanel>
      )}

      {/* Draggable Floating Request Evaluation Result Popup Window */}
      {evaluationPopupResult && (
        <DraggablePanel
          className="evaluation-result-popup glass-card"
          initialPosition={{
            x: Math.max(24, Math.round(window.innerWidth / 2 - 210)),
            y: 120,
          }}
          ariaLabel="Acquisition Request Evaluation Result"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              {evaluationPopupResult.fulfilled_as_requested ? (
                <CheckCircle2 size={16} className="eval-icon-success" />
              ) : (
                <AlertCircle size={16} className="eval-icon-alt" />
              )}
              <span className="tooltip-tag">ACQUISITION REQUEST EVALUATION RESULT</span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setEvaluationPopupResult(null)}
                aria-label="Close evaluation result popup"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div
            className={`eval-outcome-banner ${
              evaluationPopupResult.fulfilled_as_requested ? 'fulfilled' : 'alternative'
            }`}
          >
            {evaluationPopupResult.time_mode === 'ASAP' ? (
              <>
                <strong>Request Feasible (ASAP)</strong>
                <span>
                  Earliest available conflict-free satellite pass over the target area has been
                  reserved.
                </span>
              </>
            ) : evaluationPopupResult.fulfilled_as_requested ? (
              <>
                <strong>Request Fulfilled at Requested Time</strong>
                <span>
                  A satellite is in position over the target area at your exact requested time.
                </span>
              </>
            ) : (
              <>
                <strong>Alternative Capture Time Proposed</strong>
                <span>
                  No satellite covers the target area at the exact requested time. The closest
                  feasible conflict-free pass has been reserved instead.
                </span>
              </>
            )}
          </div>

          <div className="eval-details-grid">
            <div>
              <span className="label">ASSIGNED SATELLITE</span>
              <span className="mono eval-sat-val">
                {(() => {
                  const satCfg = satellites.find(
                    (s) => s.id === evaluationPopupResult.acquisition.satellite_id
                  );
                  const satColor = satCfg ? getSatelliteColor(satCfg) : '#38bdf8';
                  const shortCode = evaluationPopupResult.acquisition.satellite_id
                    .slice(-4)
                    .toUpperCase();
                  return (
                    <>
                      <span
                        className="acq-list-sat-dot"
                        style={{
                          backgroundColor: satColor,
                          boxShadow: `0 0 8px ${satColor}`,
                        }}
                      />
                      <span>SAT-{shortCode}</span>
                    </>
                  );
                })()}
              </span>
            </div>

            <div>
              <span className="label">PLAN STATUS</span>
              <span className="mono">
                <span className="acq-status-badge reserved">
                  {evaluationPopupResult.acquisition.status}
                </span>
              </span>
            </div>

            <div>
              <span className="label">REQUESTED TIME</span>
              <span className="mono">
                {evaluationPopupResult.time_mode === 'ASAP' ||
                !evaluationPopupResult.requested_timestamp
                  ? 'As soon as possible'
                  : formatUtcTimestamp(
                      new Date(evaluationPopupResult.requested_timestamp).getTime()
                    )}
              </span>
            </div>

            <div>
              <span className="label">FEASIBLE CAPTURE TIME</span>
              <span className="mono highlight">
                {formatUtcTimestamp(
                  new Date(evaluationPopupResult.feasible_timestamp).getTime()
                )}
              </span>
            </div>

            <div>
              <span className="label">TARGET COORDINATES</span>
              <span className="mono">
                {evaluationPopupResult.acquisition.center_latitude_deg.toFixed(4)}°,{' '}
                {evaluationPopupResult.acquisition.center_longitude_deg.toFixed(4)}°
              </span>
            </div>

            <div>
              <span className="label">CAPTURE AREA</span>
              <span className="mono">
                {(evaluationPopupResult.acquisition.width_m / 1000).toFixed(0)} ×{' '}
                {(evaluationPopupResult.acquisition.height_m / 1000).toFixed(0)} km
              </span>
            </div>
          </div>

          <div className="eval-cost-box">
            <div className="eval-cost-left">
              <Sparkles size={15} className="eval-cost-icon" />
              <span>ESTIMATED ACQUISITION COST</span>
            </div>
            <span className="eval-cost-points">
              {evaluationPopupResult.estimated_cost_points} PTS
            </span>
          </div>

          <div className="eval-actions-row">
            <button
              type="button"
              className="eval-btn confirm"
              disabled={processingEvaluationAction}
              onClick={handleConfirmReservation}
            >
              <CheckCircle2 size={14} />
              <span>{processingEvaluationAction ? 'Processing...' : 'Confirm Request'}</span>
            </button>
            <button
              type="button"
              className="eval-btn cancel"
              disabled={processingEvaluationAction}
              onClick={handleCancelReservation}
            >
              <X size={14} />
              <span>Cancel Request</span>
            </button>
          </div>
        </DraggablePanel>
      )}

      {/* Evaluating Queued Request Indicator Banner (shown while requests are in the queue) */}
      {(requestsQueue.length > 0 || pendingEvaluationsCount > 0) && (
        <div className="evaluating-queue-banner glass-card" role="status" aria-live="polite">
          <RefreshCw size={15} className="spin accent-cyan" />
          <span>
            Evaluating acquisition request in orbital queue (
            {Math.max(requestsQueue.length, pendingEvaluationsCount)} pending)...
          </span>
        </div>
      )}

      {/* Temporary Satellite Status Change Toast Banner */}
      {satStatusToast && (
        <div
          className={`sat-status-toast glass-card ${satStatusToast.type}`}
          role="status"
          aria-live="polite"
        >
          {satStatusToast.type === 'disabled' ? (
            <AlertCircle size={15} className="sat-toast-icon disabled" />
          ) : (
            <CheckCircle2 size={15} className="sat-toast-icon restored" />
          )}
          <span>{satStatusToast.message}</span>
        </div>
      )}

      {/* Draggable Satellite Status Change Confirmation Dialog */}
      {confirmSatStatusTarget && (
        <DraggablePanel
          className="sat-status-confirm-popup glass-card"
          initialPosition={{
            x: Math.max(24, Math.round(window.innerWidth / 2 - 190)),
            y: 180,
          }}
          ariaLabel="Satellite Status Confirmation Dialog"
        >
          {(() => {
            const isCurrentlyDisabled =
              (confirmSatStatusTarget.status || 'active').toLowerCase() === 'disabled';
            const shortCode = confirmSatStatusTarget.id.slice(-4).toUpperCase();
            return (
              <>
                <div className="tooltip-header drag-handle-header">
                  <div className="card-header-left">
                    {isCurrentlyDisabled ? (
                      <CheckCircle2 size={16} className="eval-icon-success" />
                    ) : (
                      <AlertCircle size={16} className="eval-icon-alt" />
                    )}
                    <span className="tooltip-tag">
                      {isCurrentlyDisabled
                        ? 'RESTORE SATELLITE CONFIRMATION'
                        : 'DISABLE SATELLITE CONFIRMATION'}
                    </span>
                  </div>
                  <div className="header-actions">
                    <GripHorizontal size={15} className="drag-grip-icon" />
                    <button
                      type="button"
                      className="close-btn"
                      onClick={() => setConfirmSatStatusTarget(null)}
                      aria-label="Close satellite status confirmation"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>

                <div
                  className={`eval-outcome-banner ${
                    isCurrentlyDisabled ? 'fulfilled' : 'alternative'
                  }`}
                >
                  <strong>
                    {isCurrentlyDisabled
                      ? `Restore SAT-${shortCode} to Active Status?`
                      : `Disable SAT-${shortCode}?`}
                  </strong>
                  <span>
                    {isCurrentlyDisabled
                      ? `Confirming will set SAT-${shortCode} back to "active", reassign any acquisitions it can perform at an earlier time, and restore its operational color.`
                      : `Confirming will set SAT-${shortCode} to "disabled", automatically reprogram its pending acquisitions in ASAP mode, and mark it in gray across all views.`}
                  </span>
                </div>

                <div className="eval-actions-row">
                  <button
                    type="button"
                    className="eval-btn confirm"
                    disabled={updatingSatStatus}
                    onClick={handleConfirmSatelliteStatusChange}
                  >
                    <CheckCircle2 size={14} />
                    <span>
                      {updatingSatStatus
                        ? 'Updating...'
                        : isCurrentlyDisabled
                        ? 'Confirm Restore'
                        : 'Confirm Disable'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="eval-btn cancel"
                    disabled={updatingSatStatus}
                    onClick={() => setConfirmSatStatusTarget(null)}
                  >
                    <X size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              </>
            );
          })()}
        </DraggablePanel>
      )}

      {/* Draggable Reservation Auto-Canceled Notification Dialog */}
      {cancelNotification && (
        <DraggablePanel
          className="cancel-notification-popup glass-card"
          initialPosition={{
            x: Math.max(24, Math.round(window.innerWidth / 2 - 200)),
            y: 160,
          }}
          ariaLabel="Acquisition Reservation Canceled Notification"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              <AlertCircle size={16} className="cancel-icon-rose" />
              <span className="tooltip-tag cancel-tag">RESERVATION AUTOMATICALLY CANCELED</span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setCancelNotification(null)}
                aria-label="Close cancellation notice"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="cancel-notice-body">
            <strong>
              {cancelNotification.reason === 'acquisition_time_reached'
                ? 'Capture Window Reached Without Confirmation'
                : 'Confirmation Timeout Exceeded (1 Minute)'}
            </strong>
            <p>{cancelNotification.message}</p>
          </div>

          <button
            type="button"
            className="eval-btn cancel-dismiss-btn"
            onClick={() => setCancelNotification(null)}
          >
            <span>Dismiss</span>
          </button>
        </DraggablePanel>
      )}

      {/* Draggable Floating Acquisition Requests Queue Window */}
      {showRequestsQueueWindow && (
        <DraggablePanel
          className="requests-queue-window glass-card"
          initialPosition={{ x: 430, y: 96 }}
          ariaLabel="Acquisition Requests Queue Window"
        >
          <div className="tooltip-header drag-handle-header">
            <div className="card-header-left">
              <ListOrdered size={16} className="accent-cyan" />
              <span className="tooltip-tag">
                ACQUISITION REQUESTS QUEUE ({filteredRequestsQueue.length} PENDING)
              </span>
            </div>
            <div className="header-actions">
              <GripHorizontal size={15} className="drag-grip-icon" />
              <button
                type="button"
                className="close-btn"
                onClick={() => setShowRequestsQueueWindow(false)}
                aria-label="Close acquisition requests queue window"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="acq-plan-filter-bar">
            <label htmlFor="queue-owner-filter-select" className="acq-filter-label">
              <UserIcon size={13} />
              <span>Filter by Owner:</span>
            </label>
            <select
              id="queue-owner-filter-select"
              className="acq-user-filter-select"
              value={queueOwnerFilter}
              onChange={(e) => setQueueOwnerFilter(e.target.value)}
            >
              <option value="ALL">All Owners ({sortedRequestsQueue.length})</option>
              {users.map((u) => {
                const count = sortedRequestsQueue.filter(
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
            {filteredRequestsQueue.length === 0 ? (
              <div className="acq-empty">
                No pending acquisition requests in the queue.
              </div>
            ) : (
              filteredRequestsQueue.map((reqRow, idx) => {
                const ownerName = getUserName(reqRow.user_id);
                const sizeKm = (reqRow.width_m / 1000).toFixed(0);
                const isEvaluating = reqRow.status.toLowerCase() === 'evaluating';
                const targetTimeStr =
                  reqRow.time_mode === 'ASAP' || !reqRow.requested_timestamp
                    ? 'ASAP (Earliest Pass)'
                    : formatUtcTimestamp(new Date(reqRow.requested_timestamp).getTime());
                const createdStr = formatUtcTimestamp(new Date(reqRow.created_at).getTime());

                return (
                  <div key={reqRow.id} className="acq-plan-list-item queue-list-item">
                    <div className="acq-list-item-top">
                      <div className="acq-list-sat-group">
                        <span className="acq-list-index">#{idx + 1}</span>
                        <span className="acq-list-user-pill">{ownerName}</span>
                        <span className="acq-list-user-pill">
                          {reqRow.confirmation_mode || 'manual'}
                        </span>
                        <span className="queue-item-coords-badge">
                          ({reqRow.center_latitude_deg.toFixed(2)}°,{' '}
                          {reqRow.center_longitude_deg.toFixed(2)}°) • {sizeKm}×{sizeKm} km
                        </span>
                      </div>
                      <span
                        className={`req-status-badge ${
                          isEvaluating ? 'evaluating' : 'queued'
                        }`}
                      >
                        {isEvaluating && <RefreshCw size={10} className="spin" />}
                        <span>{reqRow.status}</span>
                      </span>
                    </div>
                    <div className="acq-list-item-bottom">
                      <span className="acq-list-time">Target: {targetTimeStr}</span>
                      <span className="acq-list-coords">Queued: {createdStr.slice(11)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DraggablePanel>
      )}

      {/* Draggable Floating Acquisition Plan Window */}
      {showAcquisitionPlanWindow && (
        <DraggablePanel
          className={`acquisition-plan-window glass-card ${
            planWindowMode === 'timeline' ? 'timeline-mode' : ''
          }`}
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
              <div className="plan-mode-toggle" role="group" aria-label="Acquisition plan view mode">
                <button
                  type="button"
                  className={`plan-mode-btn ${planWindowMode === 'list' ? 'active' : ''}`}
                  onClick={() => setPlanWindowMode('list')}
                  title="Narrow List Mode"
                >
                  List
                </button>
                <button
                  type="button"
                  className={`plan-mode-btn ${planWindowMode === 'timeline' ? 'active' : ''}`}
                  onClick={() => setPlanWindowMode('timeline')}
                  title="Full Timeline Mode"
                >
                  Timeline
                </button>
              </div>
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
            {planWindowMode === 'timeline' && (
              <>
                <div
                  className="timeline-zoom-control"
                  onWheel={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const delta = e.deltaY < 0 ? 0.15 : -0.15;
                    setTimelineZoom((prev) =>
                      Math.max(0.25, Math.min(4, Number((prev + delta).toFixed(2))))
                    );
                  }}
                  title="Adjust horizontal time scale (slider or mouse wheel)"
                >
                  <span className="timeline-zoom-label">Time Scale:</span>
                  <button
                    type="button"
                    className="timeline-zoom-step-btn"
                    onClick={() =>
                      setTimelineZoom((prev) =>
                        Math.max(0.25, Number((prev - 0.25).toFixed(2)))
                      )
                    }
                    title="Zoom out timeline"
                    aria-label="Zoom out timeline"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    className="timeline-zoom-slider"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={timelineZoom}
                    onChange={(e) => setTimelineZoom( parseFloat(e.target.value) )}
                    aria-label="Timeline horizontal zoom scale"
                  />
                  <button
                    type="button"
                    className="timeline-zoom-step-btn"
                    onClick={() =>
                      setTimelineZoom((prev) =>
                        Math.min(4, Number((prev + 0.25).toFixed(2)))
                      )
                    }
                    title="Zoom in timeline"
                    aria-label="Zoom in timeline"
                  >
                    +
                  </button>
                  <span className="timeline-zoom-value">{ timelineZoom.toFixed(2) }x</span>
                </div>
                <div className="acq-timeline-legend">
                  <span className="legend-item">
                    <span className="legend-dot pending" /> Pending
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot reserved" /> Reserved
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot acquiring" /> Acquiring
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot completed" /> Completed
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot failed" /> Failed
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot reprogrammed" /> Reprogrammed
                  </span>
                </div>
              </>
            )}
          </div>

          {planWindowMode === 'list' ? (
            <div className="acq-plan-list-container">
              {filteredAcquisitionPlan.length === 0 ? (
                <div className="acq-empty">No acquisition plan rows match the selected user filter.</div>
              ) : (
                filteredAcquisitionPlan.map((row, idx) => {
                  const isSelected =
                    activeSatellite?.id === row.satellite_id && activeAcquisitionRow?.id === row.id;
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
          ) : (
            (() => {
              const { startMs, endMs, spanMs } = timelineBounds;
              // Fixed pixel scale per minute governed solely by timelineZoom (does not shrink when endMs grows)
              const basePxPerMinute = 24;
              const pxPerMinute = basePxPerMinute * timelineZoom;
              const pxPerMs = pxPerMinute / 60_000;
              const trackWidthPx = Math.max(740, Math.ceil(spanMs * pxPerMs) + 28);

              const nowX = Math.max(
                0,
                Math.min(trackWidthPx, (clockDisplay.utcMs - startMs) * pxPerMs)
              );

              const tickIntervalMs =
                pxPerMinute >= 90
                  ? 60_000
                  : pxPerMinute >= 35
                  ? 2 * 60_000
                  : pxPerMinute >= 18
                  ? 5 * 60_000
                  : 10 * 60_000;

              const firstTickMs = Math.ceil(startMs / tickIntervalMs) * tickIntervalMs;
              const ticks: Array<{ xPx: number; hhmm: string }> = [];
              for (let tMs = firstTickMs; tMs <= endMs; tMs += tickIntervalMs) {
                const xPx = (tMs - startMs) * pxPerMs;
                const hhmm = new Date(tMs).toISOString().slice(11, 16) + ' UTC';
                ticks.push({ xPx, hhmm });
              }

              return (
                <div className="acq-timeline-container">
                  <div className="acq-timeline-scroll-area">
                    <div
                      className="acq-timeline-header"
                      style={{ width: `${112 + trackWidthPx}px` }}
                      onWheel={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const delta = e.deltaY < 0 ? 0.15 : -0.15;
                        setTimelineZoom((prev) =>
                          Math.max(0.25, Math.min(4, Number((prev + delta).toFixed(2))))
                        );
                      }}
                      title="Spin mouse wheel here to zoom timeline horizontal scale"
                    >
                      <div className="acq-timeline-sat-col-header">SATELLITE</div>
                      <div
                        className="acq-timeline-scale-header"
                        style={{ width: `${trackWidthPx}px` }}
                      >
                        {ticks.map((tk, idx) => (
                          <span
                            key={idx}
                            className="acq-timeline-tick-label"
                            style={{ left: `${tk.xPx}px` }}
                          >
                            {tk.hhmm}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div
                      className="acq-timeline-rows"
                      style={{ width: `${112 + trackWidthPx}px` }}
                    >
                      {/* Vertical current-time indicator crossing all satellite horizontal lines */}
                      <div
                        className="acq-timeline-track-overlay"
                        style={{ width: `${trackWidthPx}px` }}
                      >
                        <div
                          className="acq-timeline-now-line"
                          style={{ left: `${nowX}px` }}
                          title={`Current Time: ${formatUtcTimestamp(clockDisplay.utcMs)}`}
                        >
                          <span className="acq-timeline-now-badge">
                            {new Date(clockDisplay.utcMs).toISOString().slice(11, 19)}
                          </span>
                        </div>
                      </div>

                      {satellites.map((sat) => {
                        const satColor = getSatelliteColor(sat);
                        const isSatDisabled = sat.status === 'disabled';
                        const isSatSelected = selectedSatelliteId === sat.id;
                        const satRows = filteredAcquisitionPlan.filter(
                          (r) => r.satellite_id === sat.id
                        );
                        const shortCode = sat.id.slice(-4).toUpperCase();

                        return (
                          <div
                            key={sat.id}
                            className={`acq-timeline-row ${isSatSelected ? 'selected-sat' : ''}`}
                          >
                            <button
                              type="button"
                              className={`acq-sat-row-label ${isSatDisabled ? 'is-disabled-text' : ''}`}
                              onClick={() => setSelectedSatelliteId(sat.id)}
                              title={`${sat.id} (${isSatDisabled ? 'Disabled' : 'Active'}) — ${satRows.length} acquisition(s)`}
                            >
                              <span
                                className="acq-list-sat-dot"
                                style={{
                                  backgroundColor: satColor,
                                  boxShadow: isSatDisabled ? 'none' : `0 0 6px ${satColor}`,
                                }}
                              />
                              <span className="acq-sat-row-code">SAT-{shortCode}</span>
                            </button>

                            <div
                              className="acq-timeline-track"
                              style={{ width: `${trackWidthPx}px` }}
                            >
                              <div
                                className="acq-timeline-line"
                                style={{
                                  borderColor: isSatDisabled
                                    ? 'rgba(148, 163, 184, 0.25)'
                                    : 'rgba(148, 163, 184, 0.38)',
                                }}
                              />
                              {satRows.map((row) => {
                                const rowMs = new Date(row.acquisition_timestamp).getTime();
                                const xPx = Math.max(
                                  6,
                                  Math.min(trackWidthPx - 6, (rowMs - startMs) * pxPerMs)
                                );
                                const statusClass = row.status.toLowerCase();
                                const isDotSelected =
                                  activeSatellite?.id === row.satellite_id &&
                                  activeAcquisitionRow?.id === row.id;
                                const utcStr = formatUtcTimestamp(rowMs);
                                const userName = getUserName(row.user_id);

                                return (
                                  <button
                                    key={row.id}
                                    type="button"
                                    className={`acq-timeline-dot ${statusClass} ${
                                      isDotSelected ? 'selected' : ''
                                    }`}
                                    style={{ left: `${xPx}px` }}
                                    onClick={() => selectAcquisitionAndOpenPanel(row)}
                                    title={`SAT-${shortCode} • ${row.status} • ${utcStr} • User: ${userName} • (${row.center_latitude_deg.toFixed(2)}°, ${row.center_longitude_deg.toFixed(2)}°)`}
                                    aria-label={`Select acquisition for SAT-${shortCode} at ${utcStr} (${row.status})`}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </DraggablePanel>
      )}

      {/* Draggable Floating Acquisition Status Stats (Vertical Bar Chart) Window */}
      {showStatusStatsWindow &&
        (() => {
          const statusDefs = [
            { key: 'pending', label: 'Pending', color: '#fbbf24' },
            { key: 'reserved', label: 'Reserved', color: '#c084fc' },
            { key: 'acquiring', label: 'Acquiring', color: '#38bdf8' },
            { key: 'completed', label: 'Completed', color: '#34d399' },
            { key: 'failed', label: 'Failed', color: '#fb7185' },
            { key: 'reprogrammed', label: 'Reprogrammed', color: '#818cf8' },
          ];

          const counts = statusDefs.map((def) => {
            const count = acquisitionPlan.filter(
              (r) => (r.status || '').toLowerCase() === def.key
            ).length;
            return { ...def, count };
          });

          const maxCount = Math.max(1, ...counts.map((c) => c.count));

          return (
            <DraggablePanel
              className="stats-window status-stats-window glass-card"
              initialPosition={{ x: Math.max(40, Math.round(window.innerWidth * 0.28)), y: 110 }}
              ariaLabel="Acquisition Plan Status Chart"
            >
              <div className="tooltip-header drag-handle-header">
                <div className="card-header-left">
                  <BarChart3 size={16} className="accent-cyan" />
                  <span className="tooltip-tag">
                    ACQUISITION STATUS DISTRIBUTION ({acquisitionPlan.length} TOTAL)
                  </span>
                </div>
                <div className="header-actions">
                  <GripHorizontal size={15} className="drag-grip-icon" />
                  <button
                    type="button"
                    className="close-btn"
                    onClick={() => setShowStatusStatsWindow(false)}
                    aria-label="Close status stats window"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="status-bars-chart">
                {counts.map((item) => {
                  const heightPct = Math.round((item.count / maxCount) * 100);
                  return (
                    <div key={item.key} className="status-bar-col">
                      <span className="status-bar-value" style={{ color: item.color }}>
                        {item.count}
                      </span>
                      <div className="status-bar-track">
                        <div
                          className="status-bar-fill"
                          style={{
                            height: `${item.count > 0 ? Math.max(6, heightPct) : 2}%`,
                            background: `linear-gradient(180deg, ${item.color} 0%, ${item.color}55 100%)`,
                            boxShadow: item.count > 0 ? `0 0 12px ${item.color}66` : 'none',
                            borderColor: item.color,
                          }}
                        />
                      </div>
                      <span className="status-bar-label">{item.label}</span>
                    </div>
                  );
                })}
              </div>
            </DraggablePanel>
          );
        })()}

      {/* Draggable Floating Completed vs Failed / Reprogrammed Over Time Line Chart Window */}
      {showTimelineStatsWindow &&
        (() => {
          const pts =
            statsHistory.length >= 2
              ? statsHistory
              : [
                  {
                    timeMs: (statsHistory[0]?.timeMs ?? Date.now()) - 10_000,
                    completed: 0,
                    failed: 0,
                    reprogrammed: 0,
                    failedOrReprogrammed: 0,
                  },
                  ...(statsHistory.length === 1
                    ? statsHistory
                    : [
                        {
                          timeMs: Date.now(),
                          completed: 0,
                          failed: 0,
                          reprogrammed: 0,
                          failedOrReprogrammed: 0,
                        },
                      ]),
                ];

          const minTime = pts[0].timeMs;
          const maxTime = Math.max(minTime + 1000, pts[pts.length - 1].timeMs);
          const maxVal = Math.max(
            5,
            ...pts.map((p) => Math.max(p.completed, p.failedOrReprogrammed))
          );

          const svgW = 500;
          const svgH = 210;
          const padL = 38;
          const padR = 16;
          const padT = 16;
          const padB = 30;
          const plotW = svgW - padL - padR;
          const plotH = svgH - padT - padB;

          const toX = (t: number) => padL + ((t - minTime) / (maxTime - minTime)) * plotW;
          const toY = (v: number) => padT + plotH - (v / maxVal) * plotH;

          const completedPoints = pts
            .map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.completed).toFixed(1)}`)
            .join(' ');
          const failedReprogPoints = pts
            .map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.failedOrReprogrammed).toFixed(1)}`)
            .join(' ');
          const failedOnlyPoints = pts
            .map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.failed).toFixed(1)}`)
            .join(' ');
          const reprogrammedOnlyPoints = pts
            .map((p) => `${toX(p.timeMs).toFixed(1)},${toY(p.reprogrammed).toFixed(1)}`)
            .join(' ');

          const yTicks = [
            0,
            Math.round(maxVal * 0.25),
            Math.round(maxVal * 0.5),
            Math.round(maxVal * 0.75),
            maxVal,
          ];
          const uniqueYTicks = Array.from(new Set(yTicks));
          const latest = pts[pts.length - 1];

          return (
            <DraggablePanel
              className="stats-window timeline-stats-window glass-card"
              initialPosition={{ x: Math.max(60, Math.round(window.innerWidth * 0.32)), y: 140 }}
              ariaLabel="Completed vs Failed or Reprogrammed Over Time Line Chart"
            >
              <div className="tooltip-header drag-handle-header">
                <div className="card-header-left">
                  <LineChart size={16} className="accent-cyan" />
                  <span className="tooltip-tag">
                    COMPLETED VS FAILED / REPROGRAMMED OVER TIME
                  </span>
                </div>
                <div className="header-actions">
                  <GripHorizontal size={15} className="drag-grip-icon" />
                  <button
                    type="button"
                    className="close-btn"
                    onClick={() => setShowTimelineStatsWindow(false)}
                    aria-label="Close timeline stats window"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="line-chart-legend-bar">
                <span className="line-legend-item">
                  <span className="line-legend-swatch completed" />
                  Completed: <strong>{latest.completed}</strong>
                </span>
                <span className="line-legend-item">
                  <span className="line-legend-swatch failed-reprog" />
                  Failed + Reprogrammed: <strong>{latest.failedOrReprogrammed}</strong>
                </span>
                <span className="line-legend-item sub">
                  <span className="line-legend-swatch failed-dashed" />
                  Failed: <strong>{latest.failed}</strong>
                </span>
                <span className="line-legend-item sub">
                  <span className="line-legend-swatch reprog-dashed" />
                  Reprogrammed: <strong>{latest.reprogrammed}</strong>
                </span>
              </div>

              <div className="line-chart-svg-wrapper">
                <svg
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  className="stats-line-svg"
                  role="img"
                  aria-label="Line chart of Completed versus Failed or Reprogrammed acquisitions over time"
                >
                  {/* Horizontal gridlines & Y-axis labels */}
                  {uniqueYTicks.map((yv) => {
                    const y = toY(yv);
                    return (
                      <g key={yv}>
                        <line
                          x1={padL}
                          y1={y}
                          x2={svgW - padR}
                          y2={y}
                          stroke="rgba(148, 163, 184, 0.18)"
                          strokeDasharray="3 3"
                        />
                        <text
                          x={padL - 8}
                          y={y + 3}
                          textAnchor="end"
                          fill="#94a3b8"
                          fontSize="10"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {yv}
                        </text>
                      </g>
                    );
                  })}

                  {/* X-axis baseline & start/mid/end timestamps */}
                  <line
                    x1={padL}
                    y1={padT + plotH}
                    x2={svgW - padR}
                    y2={padT + plotH}
                    stroke="rgba(148, 163, 184, 0.35)"
                  />
                  {[0, 0.5, 1].map((frac, idx) => {
                    const t = minTime + (maxTime - minTime) * frac;
                    const x = padL + plotW * frac;
                    const label = new Date(t).toISOString().slice(11, 19) + ' UTC';
                    return (
                      <text
                        key={idx}
                        x={x}
                        y={svgH - 8}
                        textAnchor={idx === 0 ? 'start' : idx === 2 ? 'end' : 'middle'}
                        fill="#94a3b8"
                        fontSize="9.5"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {label}
                      </text>
                    );
                  })}

                  {/* Dashed breakdown lines for Failed and Reprogrammed */}
                  <polyline
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                    opacity="0.75"
                    points={failedOnlyPoints}
                  />
                  <polyline
                    fill="none"
                    stroke="#818cf8"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                    opacity="0.75"
                    points={reprogrammedOnlyPoints}
                  />

                  {/* Primary Line: Failed + Reprogrammed */}
                  <polyline
                    fill="none"
                    stroke="#fb7185"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={failedReprogPoints}
                  />

                  {/* Primary Line: Completed */}
                  <polyline
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={completedPoints}
                  />

                  {/* Latest point markers */}
                  <circle
                    cx={toX(latest.timeMs)}
                    cy={toY(latest.failedOrReprogrammed)}
                    r="4"
                    fill="#fb7185"
                    stroke="#ffffff"
                    strokeWidth="1.2"
                  />
                  <circle
                    cx={toX(latest.timeMs)}
                    cy={toY(latest.completed)}
                    r="4"
                    fill="#34d399"
                    stroke="#ffffff"
                    strokeWidth="1.2"
                  />
                </svg>
              </div>
            </DraggablePanel>
          );
        })()}

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
            <button
              type="button"
              className={`sat-color-dot sat-status-btn ${
                (activeSatellite.status || 'active') === 'disabled' ? 'is-disabled' : 'is-active'
              }`}
              style={{
                backgroundColor: activeSatellite.color,
                boxShadow: `0 0 10px ${activeSatellite.color}`,
              }}
              onClick={() => setConfirmSatStatusTarget(activeSatellite)}
              title={
                (activeSatellite.status || 'active') === 'disabled'
                  ? 'Satellite is disabled — Click to restore satellite'
                  : 'Satellite is active — Click to disable satellite'
              }
              aria-label={
                (activeSatellite.status || 'active') === 'disabled'
                  ? 'Restore satellite'
                  : 'Disable satellite'
              }
            />
            <select
              aria-label="Select Satellite ID"
              className={`sat-id-select ${
                (activeSatellite.status || 'active').toLowerCase() === 'disabled'
                  ? 'is-disabled-text'
                  : ''
              }`}
              value={activeSatellite.id}
              onChange={(e) => setSelectedSatelliteId(e.target.value)}
              style={{ borderColor: `${activeSatellite.color}66` }}
            >
              {satellites.map((sat) => {
                const shortCode = sat.id.slice(-4).toUpperCase();
                const isDisabled = (sat.status || 'active').toLowerCase() === 'disabled';
                return (
                  <option
                    key={sat.id}
                    value={sat.id}
                    style={{ fontStyle: isDisabled ? 'italic' : 'normal' }}
                  >
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
                      {isAcquisitionFailed ? (
                        <button
                          type="button"
                          className="acq-action-btn reprogram-acq"
                          onClick={() => handleOpenReprogramDialog(activeAcquisitionRow)}
                          title="Open Request Image dialog with this failed acquisition's location to reprogram capture"
                        >
                          <RotateCcw size={13} />
                          <span>Reprogram Acquisition</span>
                        </button>
                      ) : (
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
                      )}
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

          <button
            type="button"
            className="acq-action-btn mark-failed-btn"
            disabled={markingFailed}
            onClick={handleMarkAcquisitionFailed}
            title="Mark this completed acquisition as Failed so it can be reprogrammed"
          >
            <AlertCircle size={13} />
            <span>{markingFailed ? 'Marking as Failed...' : 'Mark as Failed'}</span>
          </button>
        </DraggablePanel>
      )}
    </div>
  );
}

export default App;
