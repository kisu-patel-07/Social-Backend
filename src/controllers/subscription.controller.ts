import { Request, Response } from 'express';
import { subscriptionService } from '../services';
import { couponService } from '../services/coupon.service';
import { planRepository } from '../repositories';
import { NotFoundError } from '../utils/AppError';
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

  /** Price a coupon against a plan before the customer commits to paying. */
  validateCoupon: asyncHandler(async (req: Request, res: Response) => {
    const plan = await planRepository.findById(req.body.planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');
    const quote = await couponService.quote({
      code: req.body.code,
      plan,
      workspaceId: req.user!.workspaceId,
    });
    sendSuccess(res, quote, `Coupon applied — ${quote.summary}`);
  }),

  checkout: asyncHandler(async (req: Request, res: Response) => {
    const order = await subscriptionService.createCheckout(
      req.user!,
      req.body.planId,
      req.body.couponCode
    );
    sendSuccess(
      res,
      order,
      order.free ? 'Your coupon covered the full price — plan activated 🎉' : 'Order created'
    );
  }),

  checkoutVerify: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.verifyCheckout(req.user!, req.body);
    sendSuccess(res, subscription, 'Payment successful — plan activated 🎉');
  }),

  /** Start an auto-renewing subscription (Razorpay collects a mandate once). */
  subscribe: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.createSubscriptionCheckout(
      req.user!,
      req.body.planId
    );
    sendSuccess(res, subscription, 'Subscription created');
  }),

  subscribeVerify: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.verifySubscriptionCheckout(req.user!, req.body);
    sendSuccess(res, subscription, 'Payment successful — your plan renews automatically 🎉');
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.cancelPlan(req.user!);
    sendSuccess(res, subscription, "Your plan won't renew — you keep full access until it ends");
  }),

  resume: asyncHandler(async (req: Request, res: Response) => {
    const subscription = await subscriptionService.resumePlan(req.user!);
    sendSuccess(res, subscription, 'Your plan is active again');
  }),

  requestUpgrade: asyncHandler(async (req: Request, res: Response) => {
    await subscriptionService.requestUpgrade(req.user!, req.body.planId);
    sendSuccess(res, null, "Request sent — we'll activate your plan shortly");
  }),
};
