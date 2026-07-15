import { Router } from 'express';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller';
import { authenticate, requireSuperAdmin } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  adminAutomationStatusSchema,
  adminBannerSchema,
  adminBroadcastSchema,
  adminCreatePlanSchema,
  adminListActivitySchema,
  adminListAutomationsSchema,
  adminListPaymentsSchema,
  adminListSubscriptionsSchema,
  adminListUsersSchema,
  adminListWorkspacesSchema,
  adminSearchWorkspacesSchema,
  adminSuspendUserSchema,
  adminTotpCodeSchema,
  adminUserNotesSchema,
  adminUpdateFeatureSchema,
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
router.post(
  '/users/:id/impersonate',
  validate(z.object({ params: idParamSchema })),
  adminController.impersonate
);
router.get(
  '/users/:id/export',
  validate(z.object({ params: idParamSchema })),
  adminController.exportUser
);
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

// Payments (bookkeeping refunds until a gateway is integrated)
router.get('/payments', validate(adminListPaymentsSchema), adminController.listPayments);
router.patch(
  '/payments/:id/refund',
  validate(z.object({ params: idParamSchema })),
  adminController.refundPayment
);

// Feature flags + workspace search for the allowlist picker
router.get('/features', adminController.listFeatures);
router.patch('/features/:key', validate(adminUpdateFeatureSchema), adminController.updateFeature);
router.get('/workspaces', validate(adminSearchWorkspacesSchema), adminController.searchWorkspaces);

// Admin 2FA (TOTP) for the acting super admin
router.post('/2fa/setup', adminController.totpSetup);
router.post('/2fa/enable', validate(adminTotpCodeSchema), adminController.totpEnable);
router.post('/2fa/disable', validate(adminTotpCodeSchema), adminController.totpDisable);

// Deep analytics
router.get('/analytics', adminController.analytics);

// Workspaces directory (paginated; /workspaces above is the max-10 picker)
router.get(
  '/workspaces-directory',
  validate(adminListWorkspacesSchema),
  adminController.listWorkspacesDirectory
);

// Internal notes on a user
router.patch('/users/:id/notes', validate(adminUserNotesSchema), adminController.setUserNotes);

// Users CSV export
router.get('/users-export', adminController.exportUsersCsv);

// Maintenance banner
router.get('/banner', adminController.getBanner);
router.put('/banner', validate(adminBannerSchema), adminController.setBanner);

// Platform-wide activity feed
router.get('/activity', validate(adminListActivitySchema), adminController.listActivity);

export default router;
