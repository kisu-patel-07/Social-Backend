import { Router } from 'express';
import { z } from 'zod';
import { studioAutomationController } from '../controllers/studioAutomation.controller';
import { authenticate } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import { requireFeature } from '../services/feature.service';
import { requireActiveSubscription, requireEntitlement } from '../services/subscription.service';
import { idParamSchema } from '../validators/common.validator';
import {
  createStudioAutomationSchema,
  listStudioAutomationsSchema,
  toggleStudioAutomationSchema,
  updateStudioAutomationSchema,
} from '../validators/studioAutomation.validator';

const router = Router();

// Studio is behind the 'studio' feature flag (admin rollout/kill switch)
// AND the plan entitlement (which plans include Studio).
router.use(authenticate, requireFeature('studio'), requireEntitlement('studio'));

router.post(
  '/',
  requireActiveSubscription,
  validate(createStudioAutomationSchema),
  studioAutomationController.create
);
router.get('/', validate(listStudioAutomationsSchema), studioAutomationController.list);
router.get(
  '/:id',
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.getById
);
router.put(
  '/:id',
  requireActiveSubscription,
  validate(updateStudioAutomationSchema),
  studioAutomationController.update
);
router.patch(
  '/:id/status',
  requireActiveSubscription,
  validate(toggleStudioAutomationSchema),
  studioAutomationController.setStatus
);
router.post(
  '/:id/duplicate',
  requireActiveSubscription,
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.duplicate
);
router.delete(
  '/:id',
  validate(z.object({ params: idParamSchema })),
  studioAutomationController.remove
);

export default router;
