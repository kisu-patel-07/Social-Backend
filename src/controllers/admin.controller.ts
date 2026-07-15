import { Request, Response } from 'express';
import { PaymentStatus, SubscriptionStatus } from '../constants';
import { adminService } from '../services/admin.service';
import { featureService } from '../services/feature.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';
import { toDateKey } from '../utils/date';

export const adminController = {
  // ---- Overview -------------------------------------------------------------
  overview: asyncHandler(async (_req: Request, res: Response) => {
    const overview = await adminService.getOverview();
    sendSuccess(res, overview);
  }),

  // ---- Users ----------------------------------------------------------------
  listUsers: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listUsers({
      ...options,
      search: req.query.search as string | undefined,
      verified: req.query.verified === undefined ? undefined : req.query.verified === 'true',
      suspended: req.query.suspended === undefined ? undefined : req.query.suspended === 'true',
    });
    sendPaginated(res, result.items, result.meta);
  }),

  getUser: asyncHandler(async (req: Request, res: Response) => {
    const detail = await adminService.getUserDetail(req.params.id);
    sendSuccess(res, detail);
  }),

  suspendUser: asyncHandler(async (req: Request, res: Response) => {
    const user = await adminService.setUserSuspended(req.user!, req.params.id, req.body.suspended);
    sendSuccess(res, user, req.body.suspended ? 'User suspended' : 'User unsuspended');
  }),

  verifyUserEmail: asyncHandler(async (req: Request, res: Response) => {
    const user = await adminService.verifyUserEmail(req.user!, req.params.id);
    sendSuccess(res, user, 'Email verified');
  }),

  deleteUser: asyncHandler(async (req: Request, res: Response) => {
    await adminService.deleteUser(req.user!, req.params.id);
    sendNoContent(res);
  }),

  // ---- Subscriptions ---------------------------------------------------------
  listSubscriptions: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listSubscriptions({
      ...options,
      status: req.query.status as SubscriptionStatus | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  updateSubscription: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await adminService.updateSubscription(req.user!, req.params.id, req.body);
    sendSuccess(res, subscription, 'Subscription updated');
  }),

  // ---- Plans ----------------------------------------------------------------
  listPlans: asyncHandler(async (_req: Request, res: Response) => {
    const plans = await adminService.listPlans();
    sendSuccess(res, plans);
  }),

  createPlan: asyncHandler(async (req: Request, res: Response) => {
    const plan = await adminService.createPlan(req.user!, req.body);
    sendCreated(res, plan, 'Plan created');
  }),

  updatePlan: asyncHandler(async (req: Request, res: Response) => {
    const plan = await adminService.updatePlan(req.user!, req.params.id, req.body);
    sendSuccess(res, plan, 'Plan updated');
  }),

  // ---- Automation oversight ---------------------------------------------------
  listAutomations: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listAutomations({
      ...options,
      status: req.query.status as string | undefined,
      kind: req.query.kind as 'classic' | 'studio' | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  setAutomationStatus: asyncHandler(async (req: Request, res: Response) => {
    await adminService.setAutomationStatus(
      req.user!,
      req.params.id,
      req.body.kind,
      req.body.status
    );
    sendSuccess(
      res,
      { id: req.params.id, status: req.body.status },
      req.body.status === 'paused' ? 'Automation paused' : 'Automation resumed'
    );
  }),

  // ---- Platform health ----------------------------------------------------------
  health: asyncHandler(async (_req: Request, res: Response) => {
    const health = await adminService.getHealth();
    sendSuccess(res, health);
  }),

  retryAccountWebhook: asyncHandler(async (req: Request, res: Response) => {
    const account = await adminService.retryAccountWebhook(req.user!, req.params.id);
    sendSuccess(res, account, 'Webhook retry attempted');
  }),

  // ---- Broadcast ----------------------------------------------------------------
  broadcast: asyncHandler(async (req: Request, res: Response) => {
    const result = await adminService.broadcast(req.user!, req.body);
    sendSuccess(res, result, `Announcement sent to ${result.recipients} user(s)`);
  }),

  // ---- Impersonation ------------------------------------------------------------
  impersonate: asyncHandler(async (req: Request, res: Response) => {
    const result = await adminService.impersonate(req.user!, req.params.id);
    sendSuccess(res, result, `Impersonation session started for ${result.user.email}`);
  }),

  // ---- GDPR export ---------------------------------------------------------------
  exportUser: asyncHandler(async (req: Request, res: Response) => {
    const data = await adminService.exportUserData(req.user!, req.params.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="user-export-${req.params.id}-${toDateKey(new Date())}.json"`
    );
    res.status(200).send(JSON.stringify(data, null, 2));
  }),

  // ---- Payments -------------------------------------------------------------------
  listPayments: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listPayments({
      ...options,
      status: req.query.status as PaymentStatus | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  refundPayment: asyncHandler(async (req: Request, res: Response) => {
    const payment = await adminService.refundPayment(req.user!, req.params.id);
    sendSuccess(res, payment, 'Payment marked as refunded');
  }),

  // ---- Feature flags ----------------------------------------------------------------
  listFeatures: asyncHandler(async (_req: Request, res: Response) => {
    const flags = await featureService.listFlags();
    sendSuccess(res, flags);
  }),

  updateFeature: asyncHandler(async (req: Request, res: Response) => {
    const flag = await featureService.updateFlag(req.params.key, req.body);
    sendSuccess(res, flag, 'Feature flag updated');
  }),

  searchWorkspaces: asyncHandler(async (req: Request, res: Response) => {
    const workspaces = await adminService.searchWorkspaces(req.query.search as string | undefined);
    sendSuccess(res, workspaces);
  }),

  // ---- Admin 2FA ---------------------------------------------------------------------
  totpSetup: asyncHandler(async (req: Request, res: Response) => {
    const setup = await adminService.totpSetup(req.user!);
    sendSuccess(res, setup, 'Scan the QR code with your authenticator app');
  }),

  totpEnable: asyncHandler(async (req: Request, res: Response) => {
    await adminService.totpEnable(req.user!, req.body.code);
    sendSuccess(res, { enabled: true }, 'Two-factor authentication enabled');
  }),

  totpDisable: asyncHandler(async (req: Request, res: Response) => {
    await adminService.totpDisable(req.user!, req.body.code);
    sendSuccess(res, { enabled: false }, 'Two-factor authentication disabled');
  }),

  // ---- Deep analytics ----------------------------------------------------------
  analytics: asyncHandler(async (_req: Request, res: Response) => {
    const analytics = await adminService.getAnalytics();
    sendSuccess(res, analytics);
  }),

  // ---- Workspaces directory -------------------------------------------------------
  listWorkspacesDirectory: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listWorkspaces({
      ...options,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  // ---- Admin notes -------------------------------------------------------------------
  setUserNotes: asyncHandler(async (req: Request, res: Response) => {
    await adminService.setUserNotes(req.user!, req.params.id, req.body.notes);
    sendSuccess(res, { notes: req.body.notes }, 'Notes saved');
  }),

  // ---- Users CSV export ----------------------------------------------------------------
  exportUsersCsv: asyncHandler(async (_req: Request, res: Response) => {
    const csv = await adminService.exportUsersCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="users-${toDateKey(new Date())}.csv"`
    );
    res.status(200).send(csv);
  }),

  // ---- Maintenance banner -----------------------------------------------------------------
  getBanner: asyncHandler(async (_req: Request, res: Response) => {
    const banner = await adminService.getBanner();
    sendSuccess(res, banner);
  }),

  setBanner: asyncHandler(async (req: Request, res: Response) => {
    const banner = await adminService.setBanner(req.user!, req.body);
    sendSuccess(res, banner, banner.enabled ? 'Banner is live' : 'Banner disabled');
  }),

  // ---- Activity --------------------------------------------------------------
  listActivity: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await adminService.listActivity({
      ...options,
      action: req.query.action as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),
};
