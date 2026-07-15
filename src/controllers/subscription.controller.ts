import { Request, Response } from 'express';
import { subscriptionService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const subscriptionController = {
  listPlans: asyncHandler(async (_req: Request, res: Response) => {
    const plans = await subscriptionService.listPlans();
    sendSuccess(res, plans);
  }),

  current: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.getCurrent(req.user!.workspaceId);
    sendSuccess(res, subscription);
  }),

  invoices: asyncHandler(async (req: Request, res: Response) => {
    const invoices = await subscriptionService.listInvoices(req.user!.workspaceId);
    sendSuccess(res, invoices);
  }),

  choose: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.choosePlan(req.user!, req.body.planId);
    sendSuccess(res, subscription, 'Plan activated');
  }),

  checkout: asyncHandler(async (req: Request, res: Response) => {
    const order = await subscriptionService.createCheckout(req.user!, req.body.planId);
    sendSuccess(res, order, 'Order created');
  }),

  checkoutVerify: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.verifyCheckout(req.user!, req.body);
    sendSuccess(res, subscription, 'Payment successful — plan activated 🎉');
  }),

  requestUpgrade: asyncHandler(async (req: Request, res: Response) => {
    await subscriptionService.requestUpgrade(req.user!, req.body.planId);
    sendSuccess(res, null, "Request sent — we'll activate your plan shortly");
  }),
};
