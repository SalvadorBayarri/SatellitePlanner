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
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getPool } from '../db';

export interface GeoEventPayload {
  id?: string;
  title: string;
  latitude: number;
  longitude: number;
  intensity: number;
  created_at?: string;
}

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

  // 1. Ensure GEO_STREAM exists (targeting geo.events.>)
  try {
    await jsm.streams.info(config.streamName);
    console.log(`[NATS] JetStream stream "${config.streamName}" already exists.`);
  } catch {
    await jsm.streams.add({
      name: config.streamName,
      subjects: config.streamSubjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_msgs: 100000,
    });
    console.log(
      `[NATS] Created JetStream stream "${config.streamName}" for subjects ${config.streamSubjects.join(', ')}`
    );
  }

  // Ensure Durable Consumer for geo.events.created exists
  try {
    await jsm.consumers.info(config.streamName, config.consumerDurableName);
  } catch {
    await jsm.consumers.add(config.streamName, {
      durable_name: config.consumerDurableName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: config.eventSubjectCreated,
    });
    console.log(
      `[NATS] Created durable consumer "${config.consumerDurableName}" on stream "${config.streamName}"`
    );
  }

  // 2. Ensure ACQUISITION_STREAM exists (targeting acquisition.plan.>)
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

  // Start background consumers
  startDurableConsumer().catch((err) => {
    console.error('[NATS] Durable consumer error:', err);
  });

  startAcquisitionStreamConsumer().catch((err) => {
    console.error('[NATS] Acquisition stream consumer error:', err);
  });
}

export async function publishGeoEventCreated(payload: GeoEventPayload): Promise<{
  event: Required<GeoEventPayload>;
  stream: string;
  seq: number;
}> {
  if (!js) {
    throw new Error('NATS JetStream client is not initialized');
  }

  const event: Required<GeoEventPayload> = {
    id: payload.id || uuidv4(),
    title: payload.title,
    latitude: Number(payload.latitude),
    longitude: Number(payload.longitude),
    intensity: Number(payload.intensity),
    created_at: payload.created_at || new Date().toISOString(),
  };

  const pubAck = await js.publish(config.eventSubjectCreated, sc.encode(JSON.stringify(event)));
  publishedCount++;

  console.log(
    `[NATS Publisher] Published event "${event.title}" (${event.id}) to ${config.eventSubjectCreated} [stream=${pubAck.stream}, seq=${pubAck.seq}]`
  );

  return {
    event,
    stream: pubAck.stream,
    seq: pubAck.seq,
  };
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

async function startDurableConsumer(): Promise<void> {
  if (!js) return;

  const consumer = await js.consumers.get(config.streamName, config.consumerDurableName);
  const messages = await consumer.consume();

  console.log(
    `[NATS Consumer] Listening for "${config.eventSubjectCreated}" messages on durable consumer "${config.consumerDurableName}"...`
  );

  for await (const msg of messages) {
    try {
      const rawData = sc.decode(msg.data);
      const data: Required<GeoEventPayload> = JSON.parse(rawData);

      const pool = getPool();
      await pool.query(
        `INSERT INTO geo_events (id, title, latitude, longitude, intensity, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [data.id, data.title, data.latitude, data.longitude, data.intensity, data.created_at]
      );

      msg.ack();
      consumedCount++;
      console.log(
        `[NATS Consumer] Persisted event "${data.title}" (${data.id}) to PostgreSQL [seq=${msg.seq}]`
      );
    } catch (err) {
      console.error('[NATS Consumer] Failed to process message:', err);
      msg.nak(5000);
    }
  }
}

/**
 * Consumes real-time "acquisition.plan.updated" messages from NATS JetStream (ACQUISITION_STREAM)
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
    const streamInfo = await jsm.streams.info(config.streamName);
    return {
      connected: true,
      server: nc.getServer(),
      stream: config.streamName,
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
