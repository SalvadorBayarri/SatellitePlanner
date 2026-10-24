import { Request, Response } from 'express';
import { getPool, checkDbHealth } from '../db';
import { publishGeoEventCreated, checkNatsHealth } from '../events/nats';

export async function getGeoEvents(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const offset = (page - 1) * limit;

    const pool = getPool();

    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM geo_events');
    const total: number = countResult.rows[0]?.total ?? 0;

    const rowsResult = await pool.query(
      `SELECT id, title, latitude, longitude, intensity, created_at
       FROM geo_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const data = rowsResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      intensity: Number(row.intensity),
      created_at: row.created_at,
    }));

    res.status(200).json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('[Controller] Error fetching geo_events:', error);
    res.status(500).json({
      error: 'Failed to retrieve geo events',
      details: error?.message,
    });
  }
}

export async function createGeoEvent(req: Request, res: Response): Promise<void> {
  try {
    const { title, latitude, longitude, intensity } = req.body;

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Field "title" is required and must be a string.' });
      return;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    const int = intensity !== undefined ? Number(intensity) : 0.75;

    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      res.status(400).json({ error: 'Field "latitude" must be a valid number between -90 and 90.' });
      return;
    }

    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Field "longitude" must be a valid number between -180 and 180.' });
      return;
    }

    if (Number.isNaN(int) || int < 0 || int > 10) {
      res.status(400).json({ error: 'Field "intensity" must be a valid number between 0 and 10.' });
      return;
    }

    const result = await publishGeoEventCreated({
      title: title.trim(),
      latitude: lat,
      longitude: lng,
      intensity: int,
    });

    res.status(202).json({
      status: 'accepted',
      message: 'Geo event published to NATS JetStream (geo.events.created)',
      jetstream: {
        stream: result.stream,
        seq: result.seq,
      },
      event: result.event,
    });
  } catch (error: any) {
    console.error('[Controller] Error publishing geo_event:', error);
    res.status(500).json({
      error: 'Failed to publish geo event to NATS JetStream',
      details: error?.message,
    });
  }
}

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const [dbStatus, natsStatus] = await Promise.all([checkDbHealth(), checkNatsHealth()]);

  const healthy = dbStatus.connected && natsStatus.connected;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      postgresql: dbStatus,
      natsJetStream: natsStatus,
    },
  });
}

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const statsResult = await pool.query(`
      SELECT
        COUNT(*)::int AS total_events,
        AVG(intensity) AS avg_intensity,
        MAX(intensity) AS max_intensity,
        MIN(intensity) AS min_intensity
      FROM geo_events
    `);

    const natsStatus = await checkNatsHealth();
    const row = statsResult.rows[0] || {};

    res.status(200).json({
      timestamp: new Date().toISOString(),
      metrics: {
        totalEvents: row.total_events ?? 0,
        avgIntensity: Number(Number(row.avg_intensity ?? 0).toFixed(3)),
        maxIntensity: Number(row.max_intensity ?? 0),
        minIntensity: Number(row.min_intensity ?? 0),
        jetstreamPublished: natsStatus.publishedCount,
        jetstreamConsumed: natsStatus.consumedCount,
        streamTotalMessages: natsStatus.streamMessages ?? 0,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to compute metrics',
      details: error?.message,
    });
  }
}
