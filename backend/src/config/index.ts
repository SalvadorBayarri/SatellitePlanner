import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.BACKEND_PORT || process.env.PORT || '3001', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/app_db',
  natsUrl: process.env.NATS_URL || 'nats://localhost:4222',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  streamName: 'GEO_STREAM',
  streamSubjects: ['geo.events.>'],
  eventSubjectCreated: 'geo.events.created',
  consumerDurableName: 'geo-events-postgres-writer',
  acquisitionStreamName: 'ACQUISITION_STREAM',
  acquisitionStreamSubjects: ['acquisition.plan.>'],
  acquisitionSubjectUpdated: 'acquisition.plan.updated',
  acquisitionSubjectRequestEvaluated: 'acquisition.plan.request_evaluated',
  acquisitionSubjectCanceled: 'acquisition.plan.canceled',
};
