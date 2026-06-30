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
};
