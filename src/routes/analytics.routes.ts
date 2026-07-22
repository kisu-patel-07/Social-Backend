import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller';
import { authenticate } from '../middlewares';
import { linkTrackingService } from '../services/linkTracking.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

const router = Router();

router.use(authenticate);

router.get('/dashboard', analyticsController.dashboard);
router.get('/overview', analyticsController.overview);
// Per-automation funnel: triggered -> DM sent -> link clicked -> lead captured.
router.get('/funnels', analyticsController.funnels);
// Click totals from tracked DM links, grouped per automation.
router.get(
  '/clicks',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await linkTrackingService.clickStats(req.user!.workspaceId));
  })
);

export default router;
