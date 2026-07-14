import { Request, Response } from 'express';
import { SubscriptionStatus } from '../constants';
import { adminService } from '../services/admin.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

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
