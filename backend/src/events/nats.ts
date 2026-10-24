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

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;
const sc = StringCodec();

let publishedCount = 0;
let consumedCount = 0;

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

  // Ensure Stream exists (GEO_STREAM targeting geo.events.>)
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
    console.log(`[NATS] Created JetStream stream "${config.streamName}" for subjects ${config.streamSubjects.join(', ')}`);
  }

  // Ensure Durable Consumer exists
  try {
    await jsm.consumers.info(config.streamName, config.consumerDurableName);
  } catch {
    await jsm.consumers.add(config.streamName, {
      durable_name: config.consumerDurableName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: config.eventSubjectCreated,
    });
    console.log(`[NATS] Created durable consumer "${config.consumerDurableName}" on stream "${config.streamName}"`);
  }

  // Start background consumer loop
  startDurableConsumer().catch((err) => {
    console.error('[NATS] Durable consumer error:', err);
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

async function startDurableConsumer(): Promise<void> {
  if (!js) return;

  const consumer = await js.consumers.get(config.streamName, config.consumerDurableName);
  const messages = await consumer.consume();

  console.log(`[NATS Consumer] Listening for "${config.eventSubjectCreated}" messages on durable consumer "${config.consumerDurableName}"...`);

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
      console.log(`[NATS Consumer] Persisted event "${data.title}" (${data.id}) to PostgreSQL [seq=${msg.seq}]`);
    } catch (err) {
      console.error('[NATS Consumer] Failed to process message:', err);
      msg.nak(5000);
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
