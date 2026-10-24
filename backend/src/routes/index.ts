import { Router } from 'express';
import {
  getGeoEvents,
  createGeoEvent,
  getHealth,
  getMetrics,
  getSatelliteFleet,
  getAcquisitionPlan,
  getAcquisitionById,
  initializeAcquisitionPlan,
} from '../controllers/geoEventsController';

const router = Router();

router.get('/health', getHealth);
router.get('/metrics', getMetrics);
router.get('/geo-events', getGeoEvents);
router.post('/geo-events', createGeoEvent);
router.get('/satellites', getSatelliteFleet);
router.get('/acquisition-plan', getAcquisitionPlan);
router.get('/acquisition-plan/:id', getAcquisitionById);
router.post('/acquisition-plan/init', initializeAcquisitionPlan);

export default router;
