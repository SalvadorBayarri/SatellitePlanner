import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initDatabase } from './db';
import { initNatsJetStream } from './events/nats';
import apiRoutes from './routes';

const app = express();

// Enable full CORS middleware allowing frontend origins
app.use(
  cors({
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// Mount REST API v1 routes
app.use('/api/v1', apiRoutes);

// Root info endpoint
app.get('/', (_req, res) => {
  res.json({
    service: 'SatellitePlanner API',
    version: '1.0.0',
    endpoints: {
      health: '/api/v1/health',
      metrics: '/api/v1/metrics',
      satellites: '/api/v1/satellites',
      acquisitionPlan: '/api/v1/acquisition-plan',
      acquisitionRequests: '/api/v1/acquisition-requests',
    },
  });
});

async function bootstrap(): Promise<void> {
  try {
    await initDatabase();
    await initNatsJetStream();

    app.listen(config.port, () => {
      console.log(`[Server] SatellitePlanner Backend API listening on http://localhost:${config.port}`);
    });
  } catch (error) {
    console.error('[Server] Fatal error during startup:', error);
    process.exit(1);
  }
}

bootstrap();
