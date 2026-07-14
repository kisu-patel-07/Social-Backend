import { Router } from 'express';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller';
import { authenticate, requireSuperAdmin } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  adminAutomationStatusSchema,
  adminBroadcastSchema,
  adminCreatePlanSchema,
  adminListActivitySchema,
  adminListAutomationsSchema,
  adminListSubscriptionsSchema,
  adminListUsersSchema,
  adminSuspendUserSchema,
  adminUpdatePlanSchema,
  adminUpdateSubscriptionSchema,
} from '../validators/admin.validator';
import { idParamSchema } from '../validators/common.validator';

/**
 * Platform-operator endpoints. Everything below requires a valid session AND
 * the isSuperAdmin flag (re-checked against the DB on every request).
 */
const router = Router();

router.use(authenticate, requireSuperAdmin);

// Overview KPIs
router.get('/overview', adminController.overview);

// User management
router.get('/users', validate(adminListUsersSchema), adminController.listUsers);
router.get('/users/:id', validate(z.object({ params: idParamSchema })), adminController.getUser);
router.patch('/users/:id/suspend', validate(adminSuspendUserSchema), adminController.suspendUser);
router.patch(
  '/users/:id/verify-email',
  validate(z.object({ params: idParamSchema })),
  adminController.verifyUserEmail
);
router.delete(
  '/users/:id',
  validate(z.object({ params: idParamSchema })),
  adminController.deleteUser
);

// Subscriptions
router.get(
  '/subscriptions',
  validate(adminListSubscriptionsSchema),
  adminController.listSubscriptions
);
router.patch(
  '/subscriptions/:id',
  validate(adminUpdateSubscriptionSchema),
  adminController.updateSubscription
);

// Plans
router.get('/plans', adminController.listPlans);
router.post('/plans', validate(adminCreatePlanSchema), adminController.createPlan);
router.put('/plans/:id', validate(adminUpdatePlanSchema), adminController.updatePlan);

// Automation oversight (classic + Studio, merged)
router.get('/automations', validate(adminListAutomationsSchema), adminController.listAutomations);
router.patch(
  '/automations/:id/status',
  validate(adminAutomationStatusSchema),
  adminController.setAutomationStatus
);

// Platform health
router.get('/health', adminController.health);
router.post(
  '/accounts/:id/retry-webhook',
  validate(z.object({ params: idParamSchema })),
  adminController.retryAccountWebhook
);

// Broadcast announcements
router.post('/broadcast', validate(adminBroadcastSchema), adminController.broadcast);

// Platform-wide activity feed
router.get('/activity', validate(adminListActivitySchema), adminController.listActivity);

export default router;
