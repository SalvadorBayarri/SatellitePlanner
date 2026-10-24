import { Router } from 'express';
import {
  getGeoEvents,
  createGeoEvent,
  getHealth,
  getMetrics,
} from '../controllers/geoEventsController';

const router = Router();

router.get('/health', getHealth);
router.get('/metrics', getMetrics);
router.get('/geo-events', getGeoEvents);
router.post('/geo-events', createGeoEvent);

export default router;
