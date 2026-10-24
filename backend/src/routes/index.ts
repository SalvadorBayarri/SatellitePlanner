import { Router } from 'express';
import {
  getGeoEvents,
  createGeoEvent,
  getHealth,
  getMetrics,
  getSatelliteFleet,
} from '../controllers/geoEventsController';

const router = Router();

router.get('/health', getHealth);
router.get('/metrics', getMetrics);
router.get('/geo-events', getGeoEvents);
router.post('/geo-events', createGeoEvent);
router.get('/satellites', getSatelliteFleet);

export default router;
