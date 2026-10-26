import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  AckPolicy,
  DeliverPolicy,
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
  }, 20_000);

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
  nc = await connect({
    servers: config.natsUrl,
    name: 'satellite-planner-backend',
    reconnect: true,
    maxReconnectAttempts: -1,
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

  // Start background consumer for real-time acquisition plan SSE push
  startAcquisitionStreamConsumer().catch((err) => {
    console.error('[NATS] Acquisition stream consumer error:', err);
  });
}

/**
 * Publishes an acquisition plan row status/image transition to NATS JetStream (acquisition.plan.updated).
 * If NATS is temporarily disconnected, still broadcasts directly to connected SSE clients as fallback.
 */
export async function publishAcquisitionUpdated(
  payload: AcquisitionPlanUpdatePayload
): Promise<void> {
  if (!js) {
    broadcastAcquisitionUpdateToSseClients(payload);
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    console.log(
      `[NATS Publisher] Published acquisition update (${payload.id} -> ${payload.status}) to ${config.acquisitionSubjectUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn('[NATS Publisher] Failed to publish acquisition update to JetStream, using direct SSE broadcast:', err);
    broadcastAcquisitionUpdateToSseClients(payload);
  }
}

/**
 * Publishes an acquisition request evaluation result to NATS JetStream (acquisition.plan.request_evaluated).
 * If NATS is temporarily disconnected, broadcasts directly to connected SSE clients as fallback.
 */
export async function publishAcquisitionRequestEvaluated(
  payload: AcquisitionRequestEvaluationPayload
): Promise<void> {
  if (!js) {
    broadcastRequestEvaluationToSseClients(payload);
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectRequestEvaluated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    console.log(
      `[NATS Publisher] Published request evaluation (${payload.request_id} -> acquisition ${payload.acquisition.id}) to ${config.acquisitionSubjectRequestEvaluated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish request evaluation to JetStream, using direct SSE broadcast:',
      err
    );
    broadcastRequestEvaluationToSseClients(payload);
  }
}

/**
 * Publishes an acquisition cancellation/expiration event to NATS JetStream (acquisition.plan.canceled).
 * If NATS is temporarily disconnected, broadcasts directly to connected SSE clients as fallback.
 */
export async function publishAcquisitionCanceled(
  payload: AcquisitionPlanCancelPayload
): Promise<void> {
  if (!js) {
    broadcastAcquisitionCancelToSseClients(payload);
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectCanceled,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    console.log(
      `[NATS Publisher] Published acquisition cancel (${payload.acquisition_id}, reason=${payload.reason}) to ${config.acquisitionSubjectCanceled} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish acquisition cancel to JetStream, using direct SSE broadcast:',
      err
    );
    broadcastAcquisitionCancelToSseClients(payload);
  }
}

/**
 * Publishes an acquisition request queue snapshot to NATS JetStream (acquisition.plan.queue_updated)
 * whenever a request is added, starts evaluating, or is removed from the pending queue.
 */
export async function publishAcquisitionQueueUpdated(
  payload: AcquisitionQueueUpdatePayload
): Promise<void> {
  if (!js) {
    broadcastAcquisitionQueueUpdateToSseClients(payload);
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectQueueUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    console.log(
      `[NATS Publisher] Published request queue update (${payload.queue.length} pending) to ${config.acquisitionSubjectQueueUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish request queue update to JetStream, using direct SSE broadcast:',
      err
    );
    broadcastAcquisitionQueueUpdateToSseClients(payload);
  }
}

/**
 * Publishes a satellite status change ('active' | 'disabled') to NATS JetStream
 * (acquisition.plan.satellite_status_updated) and fans out via SSE to connected clients.
 */
export async function publishSatelliteStatusUpdated(
  payload: SatelliteStatusUpdatePayload
): Promise<void> {
  if (!js) {
    broadcastSatelliteStatusUpdateToSseClients(payload);
    return;
  }

  try {
    const pubAck = await js.publish(
      config.acquisitionSubjectSatelliteStatusUpdated,
      sc.encode(JSON.stringify(payload))
    );
    publishedCount++;
    console.log(
      `[NATS Publisher] Published satellite status update (${payload.id} -> ${payload.status}) to ${config.acquisitionSubjectSatelliteStatusUpdated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
    );
  } catch (err) {
    console.warn(
      '[NATS Publisher] Failed to publish satellite status update to JetStream, using direct SSE broadcast:',
      err
    );
    broadcastSatelliteStatusUpdateToSseClients(payload);
  }
}

/**
 * Consumes real-time "acquisition.plan.>" messages from NATS JetStream (ACQUISITION_STREAM)
 * and pushes them immediately to all subscribed frontend SSE clients.
 */
async function startAcquisitionStreamConsumer(): Promise<void> {
  if (!js || !jsm) return;

  const consumerInfo = await jsm.consumers.add(config.acquisitionStreamName, {
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    filter_subject: 'acquisition.plan.>',
  });

  const consumer = await js.consumers.get(config.acquisitionStreamName, consumerInfo.name);
  const messages = await consumer.consume();

  console.log(
    `[NATS Consumer] Listening for "acquisition.plan.>" messages on stream "${config.acquisitionStreamName}" for SSE push...`
  );

  for await (const msg of messages) {
    try {
      const rawData = sc.decode(msg.data);
      const parsed = JSON.parse(rawData);
      msg.ack();
      consumedCount++;
      if (msg.subject === config.acquisitionSubjectRequestEvaluated) {
        broadcastRequestEvaluationToSseClients(parsed as AcquisitionRequestEvaluationPayload);
      } else if (msg.subject === config.acquisitionSubjectCanceled) {
        broadcastAcquisitionCancelToSseClients(parsed as AcquisitionPlanCancelPayload);
      } else if (msg.subject === config.acquisitionSubjectQueueUpdated) {
        broadcastAcquisitionQueueUpdateToSseClients(parsed as AcquisitionQueueUpdatePayload);
      } else if (msg.subject === config.acquisitionSubjectSatelliteStatusUpdated) {
        broadcastSatelliteStatusUpdateToSseClients(parsed as SatelliteStatusUpdatePayload);
      } else {
        broadcastAcquisitionUpdateToSseClients(parsed as AcquisitionPlanUpdatePayload);
      }
    } catch (err) {
      console.error('[NATS Consumer] Failed to process acquisition stream message:', err);
      msg.nak(2000);
    }
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
      connected: false,
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
