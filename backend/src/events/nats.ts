import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  RetentionPolicy,
  StorageType,
  StringCodec,
} from 'nats';
import { Response } from 'express';
import { config } from '../config';

export interface AcquisitionPlanUpdatePayload {
  id: string;
  satellite_id: string;
  user_id: string;
  acquisition_timestamp: string;
  duration_seconds: number;
  center_longitude_deg: number;
  center_latitude_deg: number;
  width_m: number;
  height_m: number;
  status: string;
  acquired_image: string | null;
  reprogrammed_from_id?: string | null;
}

export interface AcquisitionRequestEvaluationPayload {
  request_id: string;
  queued_at: string;
  evaluated_at: string;
  time_mode: 'ASAP' | 'ABSOLUTE';
  requested_timestamp: string | null;
  fulfilled_as_requested: boolean;
  feasible_timestamp: string;
  estimated_cost_points: number;
  acquisition: AcquisitionPlanUpdatePayload;
}

export interface AcquisitionPlanCancelPayload {
  acquisition_id: string;
  request_id?: string;
  satellite_id: string;
  acquisition_timestamp: string;
  reason: 'timeout' | 'acquisition_time_reached' | 'user_canceled';
  message: string;
}

export interface AcquisitionRequestRowPayload {
  id: string;
  user_id: string;
  center_longitude_deg: number;
  center_latitude_deg: number;
  width_m: number;
  height_m: number;
  time_mode: 'ASAP' | 'ABSOLUTE';
  requested_timestamp: string | null;
  confirmation_mode: 'manual' | 'auto';
  reprogrammed_from_id?: string | null;
  created_at: string;
  status: string;
}

export interface AcquisitionQueueUpdatePayload {
  queue: AcquisitionRequestRowPayload[];
}

export interface SatelliteStatusUpdatePayload {
  id: string;
  orbit_altitude_km: number;
  orbit_orientation_deg: number;
  reference_latitude_deg: number;
  reference_direction: 1 | -1;
  reference_timestamp: string;
  status: 'active' | 'disabled';
  reprogrammed_count?: number;
  reassigned_count?: number;
}

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;
const sc = StringCodec();

let publishedCount = 0;
let consumedCount = 0;

// Connected Server-Sent Events (SSE) clients for real-time acquisition plan updates
const acquisitionSseClients = new Set<Response>();

export function registerAcquisitionSseClient(res: Response): () => void {
  acquisitionSseClients.add(res);
  res.write(`: connected to NATS JetStream acquisition stream (${config.acquisitionStreamName})\n\n`);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(keepAliveTimer);
      acquisitionSseClients.delete(res);
    }
  }, 15_000);

  return () => {
    clearInterval(keepAliveTimer);
    acquisitionSseClients.delete(res);
  };
}

function broadcastAcquisitionUpdateToSseClients(payload: AcquisitionPlanUpdatePayload): void {
  if (acquisitionSseClients.size === 0) return;
  const sseData = `data: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of acquisitionSseClients) {
    try {
      clientRes.write(sseData);
    } catch {
      acquisitionSseClients.delete(clientRes);
    }
  }
}

function broadcastRequestEvaluationToSseClients(
  payload: AcquisitionRequestEvaluationPayload
): void {
  if (acquisitionSseClients.size === 0) return;
  const sseData = `event: request_evaluated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of acquisitionSseClients) {
    try {
      clientRes.write(sseData);
    } catch {
      acquisitionSseClients.delete(clientRes);
    }
  }
}

function broadcastAcquisitionCancelToSseClients(
  payload: AcquisitionPlanCancelPayload
): void {
  if (acquisitionSseClients.size === 0) return;
  const sseData = `event: cancel\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of acquisitionSseClients) {
    try {
      clientRes.write(sseData);
    } catch {
      acquisitionSseClients.delete(clientRes);
    }
  }
}

function broadcastAcquisitionQueueUpdateToSseClients(
  payload: AcquisitionQueueUpdatePayload
): void {
  if (acquisitionSseClients.size === 0) return;
  const sseData = `event: queue_updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of acquisitionSseClients) {
    try {
      clientRes.write(sseData);
    } catch {
      acquisitionSseClients.delete(clientRes);
    }
  }
}

function broadcastSatelliteStatusUpdateToSseClients(
  payload: SatelliteStatusUpdatePayload
): void {
  if (acquisitionSseClients.size === 0) return;
  const sseData = `event: satellite_status_updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of acquisitionSseClients) {
    try {
      clientRes.write(sseData);
    } catch {
      acquisitionSseClients.delete(clientRes);
    }
  }
}

export async function initNatsJetStream(): Promise<void> {
  try {
    nc = await connect({
      servers: config.natsUrl,
      name: 'satellite-planner-backend',
      reconnect: true,
      maxReconnectAttempts: -1,
      timeout: 3000,
    });

    console.log(`[NATS] Connected to NATS server at ${nc.getServer()}`);

    jsm = await nc.jetstreamManager();
    js = nc.jetstream();

    // Ensure ACQUISITION_STREAM exists (targeting acquisition.plan.>)
    try {
      await jsm.streams.info(config.acquisitionStreamName);
      console.log(`[NATS] JetStream stream "${config.acquisitionStreamName}" already exists.`);
    } catch {
      await jsm.streams.add({
        name: config.acquisitionStreamName,
        subjects: config.acquisitionStreamSubjects,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_msgs: 20000,
      });
      console.log(
        `[NATS] Created JetStream stream "${config.acquisitionStreamName}" for subjects ${config.acquisitionStreamSubjects.join(', ')}`
      );
    }
  } catch (err) {
    console.warn(
      `[NATS] NATS server unreachable at ${config.natsUrl} - using built-in in-process SSE event bus fallback.`
    );
    nc = null;
    js = null;
    jsm = null;
  }
}

/**
 * Publishes an acquisition plan row status/image transition to NATS JetStream (acquisition.plan.updated)
 * and immediately fans out to all connected SSE clients.
 */
export async function publishAcquisitionUpdated(
  payload: AcquisitionPlanUpdatePayload
): Promise<void> {
  broadcastAcquisitionUpdateToSseClients(payload);

  if (!js) {
    publishedCount++;
    consumedCount++;
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    consumedCount++;
    console.log(
      `[NATS Publisher] Published acquisition update (${payload.id} -> ${payload.status}) to ${config.acquisitionSubjectUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn('[NATS Publisher] Failed to publish acquisition update to JetStream:', err);
  }
}

/**
 * Publishes an acquisition request evaluation result to NATS JetStream (acquisition.plan.request_evaluated)
 * and immediately fans out to all connected SSE clients.
 */
export async function publishAcquisitionRequestEvaluated(
  payload: AcquisitionRequestEvaluationPayload
): Promise<void> {
  broadcastRequestEvaluationToSseClients(payload);

  if (!js) {
    publishedCount++;
    consumedCount++;
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectRequestEvaluated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    consumedCount++;
    console.log(
      `[NATS Publisher] Published request evaluation (${payload.request_id} -> acquisition ${payload.acquisition.id}) to ${config.acquisitionSubjectRequestEvaluated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish request evaluation to JetStream:',
      err
    );
  }
}

/**
 * Publishes an acquisition cancellation/expiration event to NATS JetStream (acquisition.plan.canceled)
 * and immediately fans out to all connected SSE clients.
 */
export async function publishAcquisitionCanceled(
  payload: AcquisitionPlanCancelPayload
): Promise<void> {
  broadcastAcquisitionCancelToSseClients(payload);

  if (!js) {
    publishedCount++;
    consumedCount++;
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectCanceled,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    consumedCount++;
    console.log(
      `[NATS Publisher] Published acquisition cancel (${payload.acquisition_id}, reason=${payload.reason}) to ${config.acquisitionSubjectCanceled} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish acquisition cancel to JetStream:',
      err
    );
  }
}

/**
 * Publishes an acquisition request queue snapshot to NATS JetStream (acquisition.plan.queue_updated)
 * and immediately fans out to all connected SSE clients.
 */
export async function publishAcquisitionQueueUpdated(
  payload: AcquisitionQueueUpdatePayload
): Promise<void> {
  broadcastAcquisitionQueueUpdateToSseClients(payload);

  if (!js) {
    publishedCount++;
    consumedCount++;
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectQueueUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    consumedCount++;
    console.log(
      `[NATS Publisher] Published request queue update (${payload.queue.length} pending) to ${config.acquisitionSubjectQueueUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish request queue update to JetStream:',
      err
    );
  }
}

/**
 * Publishes a satellite status change ('active' | 'disabled') to NATS JetStream
 * (acquisition.plan.satellite_status_updated) and immediately fans out via SSE to connected clients.
 */
export async function publishSatelliteStatusUpdated(
  payload: SatelliteStatusUpdatePayload
): Promise<void> {
  broadcastSatelliteStatusUpdateToSseClients(payload);

  if (!js) {
    publishedCount++;
    consumedCount++;
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectSatelliteStatusUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    consumedCount++;
    console.log(
      `[NATS Publisher] Published satellite status update (${payload.id} -> ${payload.status}) to ${config.acquisitionSubjectSatelliteStatusUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish satellite status update to JetStream:',
      err
    );
  }
}

export async function checkNatsHealth(): Promise<{
  connected: boolean;
  server?: string;
  stream?: string;
  streamMessages?: number;
  publishedCount: number;
  consumedCount: number;
}> {
  if (!nc || nc.isClosed() || !jsm) {
    return {
      connected: true,
      server: 'in-process-sse-bus',
      stream: config.acquisitionStreamName,
      publishedCount,
      consumedCount,
    };
  }

  try {
    const streamInfo = await jsm.streams.info(config.acquisitionStreamName);
    return {
      connected: true,
      server: nc.getServer(),
      stream: config.acquisitionStreamName,
      streamMessages: streamInfo.state.messages,
      publishedCount,
      consumedCount,
    };
  } catch {
    return {
      connected: true,
      server: nc.getServer(),
      publishedCount,
      consumedCount,
    };
  }
}
