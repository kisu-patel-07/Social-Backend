import { Router } from 'express';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller';
import { demoRequestController } from '../controllers/demoRequest.controller';
import { authenticate, requireSuperAdmin } from '../middlewares';
import { validate } from '../middlewares/validate.middleware';
import {
  adminAutomationStatusSchema,
  adminBannerSchema,
  adminBroadcastSchema,
  adminBulkUsersSchema,
  adminCreatePlanSchema,
  adminCreateUserSchema,
  adminGrantBonusSchema,
  adminListActivitySchema,
  adminListDemoRequestsSchema,
  adminUpdateDemoRequestSchema,
  adminListAutomationsSchema,
  adminCreateCouponSchema,
  adminListCouponsSchema,
  adminListInvoicesSchema,
  adminListPaymentsSchema,
  adminUpdateCouponSchema,
  adminListSubscriptionsSchema,
  adminListUsersSchema,
  adminListWorkspacesSchema,
  adminSearchWorkspacesSchema,
  adminSupportUpdateSchema,
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
router.post('/users', validate(adminCreateUserSchema), adminController.createUser);
// Registered before /users/:id so "bulk" is never captured as an id.
router.post('/users/bulk', validate(adminBulkUsersSchema), adminController.bulkUpdateUsers);
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
router.get('/billing-insights', adminController.billingInsights);
router.patch(
  '/subscriptions/:id',
  validate(adminUpdateSubscriptionSchema),
  adminController.updateSubscription
);
router.patch(
  '/subscriptions/:id/bonus',
  validate(adminGrantBonusSchema),
  adminController.grantBonus
);

// Plans
router.get('/plans', adminController.listPlans);
router.post('/plans', validate(adminCreatePlanSchema), adminController.createPlan);
router.put('/plans/:id', validate(adminUpdatePlanSchema), adminController.updatePlan);
router.post(
  '/plans/:id/sync-razorpay',
  validate(z.object({ params: idParamSchema })),
  adminController.syncPlan
);
router.delete(
  '/plans/:id',
  validate(z.object({ params: idParamSchema })),
  adminController.deletePlan
);

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

// Payments (refunds go through Razorpay when the payment carries a gateway id)
router.get('/payments', validate(adminListPaymentsSchema), adminController.listPayments);
router.patch(
  '/payments/:id/refund',
  validate(z.object({ params: idParamSchema })),
  adminController.refundPayment
);
router.get('/invoices', validate(adminListInvoicesSchema), adminController.listInvoices);

// Coupons (one-time discount codes)
router.get('/coupons', validate(adminListCouponsSchema), adminController.listCoupons);
router.post('/coupons', validate(adminCreateCouponSchema), adminController.createCoupon);
router.get(
  '/coupons/:id/redemptions',
  validate(z.object({ params: idParamSchema })),
  adminController.listCouponRedemptions
);
router.patch('/coupons/:id', validate(adminUpdateCouponSchema), adminController.updateCoupon);
router.delete(
  '/coupons/:id',
  validate(z.object({ params: idParamSchema })),
  adminController.deleteCoupon
);

// Demo-call requests (public form -> admin follow-up)
router.get(
  '/demo-requests',
  validate(adminListDemoRequestsSchema),
  demoRequestController.adminList
);
router.patch(
  '/demo-requests/:id',
  validate(adminUpdateDemoRequestSchema),
  demoRequestController.adminUpdate
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
router.get(
  '/workspaces-directory/:id',
  validate(z.object({ params: idParamSchema })),
  adminController.getWorkspaceDetail
);

// Internal notes on a user
router.patch('/users/:id/notes', validate(adminUserNotesSchema), adminController.setUserNotes);

// "Locked out" support: email the user a password-reset link.
router.post(
  '/users/:id/send-password-reset',
  validate(z.object({ params: idParamSchema })),
  adminController.sendPasswordReset
);

// Support inbox (public contact-form submissions)
router.get('/support', adminController.listSupport);
router.patch('/support/:id', validate(adminSupportUpdateSchema), adminController.updateSupport);

// Webhook debug trail (Meta + Razorpay deliveries)
router.get('/webhook-events', adminController.listWebhookEvents);
router.post(
  '/webhook-events/:id/reprocess',
  validate(z.object({ params: idParamSchema })),
  adminController.reprocessWebhookEvent
);

// Users CSV export
router.get('/users-export', adminController.exportUsersCsv);
router.get('/activity-export', adminController.exportActivityCsv);

// Maintenance banner
router.get('/banner', adminController.getBanner);
router.put('/banner', validate(adminBannerSchema), adminController.setBanner);

// Platform-wide activity feed
router.get('/activity', validate(adminListActivitySchema), adminController.listActivity);

export default router;
