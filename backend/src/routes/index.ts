import { Router } from 'express';
import {
  getGeoEvents,
  createGeoEvent,
  getHealth,
  getMetrics,
  getSatelliteFleet,
  getUsers,
  getAcquisitionPlan,
  getAcquisitionById,
  initializeAcquisitionPlan,
  streamAcquisitionPlanUpdates,
  submitAcquisitionRequest,
  confirmReservedAcquisition,
  cancelReservedAcquisition,
} from '../controllers/geoEventsController';

const router = Router();

router.get('/health', getHealth);
router.get('/metrics', getMetrics);
router.get('/geo-events', getGeoEvents);
router.post('/geo-events', createGeoEvent);
router.get('/satellites', getSatelliteFleet);
router.get('/users', getUsers);
router.get('/acquisition-plan', getAcquisitionPlan);
router.get('/acquisition-plan/stream', streamAcquisitionPlanUpdates);
router.post('/acquisition-plan/:id/confirm', confirmReservedAcquisition);
router.post('/acquisition-plan/:id/cancel', cancelReservedAcquisition);
router.get('/acquisition-plan/:id', getAcquisitionById);
router.post('/acquisition-plan/init', initializeAcquisitionPlan);
router.post('/acquisition-requests', submitAcquisitionRequest);

export default router;
