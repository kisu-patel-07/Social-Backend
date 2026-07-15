import { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  ActivityAction,
  BillingInterval,
  InvoiceStatus,
  NotificationType,
  PaymentStatus,
  SubscriptionStatus,
} from '../constants';
import { HttpStatus } from '../constants/httpStatus';
import { IPlan } from '../models/plan.model';
import { ISubscription } from '../models/subscription.model';
import { IInvoice } from '../models/invoice.model';
import {
  invoiceRepository,
  notificationRepository,
  paymentRepository,
  planRepository,
  subscriptionRepository,
  userRepository,
  workspaceRepository,
} from '../repositories';
import { AuthUser } from '../types/auth.types';
import { AppError, BadRequestError, NotFoundError } from '../utils/AppError';
import { addDays } from '../utils/date';
import { activityService } from './activity.service';
import { paymentService } from './payment.service';

/** Statuses that keep the product usable (PAST_DUE = payment grace period). */
const ACCESS_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

export interface AccessState {
  allowed: boolean;
  reason?: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_INACTIVE';
}

/** The current plan's limits + feature switches for a workspace. */
export interface WorkspaceEntitlements {
  limits: {
    connectedAccounts: number;
    automations: number;
    monthlyMessages: number;
    teamMembers: number;
  };
  entitlements: { studio: boolean; csvExport: boolean };
}

/** Fail-open defaults for workspaces without a subscription/plan (dev setups). */
const UNRESTRICTED: WorkspaceEntitlements = {
  limits: { connectedAccounts: -1, automations: -1, monthlyMessages: -1, teamMembers: -1 },
  entitlements: { studio: true, csvExport: true },
};

/** Throws PLAN_LIMIT_REACHED when count has hit a plan limit (-1 = unlimited). */
export function assertWithinLimit(count: number, limit: number, what: string): void {
  if (limit !== -1 && count >= limit) {
    throw new AppError(
      `Your plan allows ${limit} ${what}. Upgrade your plan to add more.`,
      HttpStatus.FORBIDDEN,
      { errorCode: 'PLAN_LIMIT_REACHED' }
    );
  }
}

/** How long one period of a plan lasts, from its billing interval. */
export function planPeriodEnd(plan: IPlan, from = new Date()): Date {
  if (plan.interval === BillingInterval.DAYS) return addDays(from, plan.durationDays ?? 30);
  if (plan.interval === BillingInterval.YEARLY) return addDays(from, 365);
  return addDays(from, 30);
}

/**
 * Subscription/billing surface. A payment gateway (Razorpay) can be wired up
 * later without refactoring; until then the trial gate below is what makes
 * "first month free, then ₹249" real.
 */
class SubscriptionService {
  listPlans(): Promise<IPlan[]> {
    return planRepository.listActive();
  }

  getCurrent(workspaceId: string): Promise<ISubscription | null> {
    return subscriptionRepository.findByWorkspace(workspaceId);
  }

  listInvoices(workspaceId: string): Promise<IInvoice[]> {
    return invoiceRepository.find({ workspace: workspaceId }, undefined, {
      sort: { createdAt: -1 },
    });
  }

  /**
   * Whether this workspace may use paid functionality right now.
   *
   * Evaluated lazily on every enforcement point (not just by the cron job),
   * so an overdue trial locks the moment it lapses; the first check that
   * catches it also persists status=EXPIRED for dashboards/admin. Workspaces
   * with no subscription document at all are allowed (unseeded dev setups).
   */
  async getAccessState(workspaceId: string): Promise<AccessState> {
    const subscription = await subscriptionRepository.findByWorkspace(workspaceId);
    if (!subscription) return { allowed: true };

    const trialOverdue =
      subscription.status === SubscriptionStatus.TRIALING &&
      subscription.trialEndsAt !== undefined &&
      subscription.trialEndsAt.getTime() < Date.now();

    if (trialOverdue) {
      await subscriptionRepository.updateById(subscription._id, {
        $set: { status: SubscriptionStatus.EXPIRED },
      });
      return { allowed: false, reason: 'TRIAL_EXPIRED' };
    }

    // Paid period lapsed without renewal → lazily drop back to the Free plan
    // (still allowed, just Free limits). Runs once; needs no cron job.
    const plan = subscription.plan as unknown as IPlan | null;
    const paidLapsed =
      subscription.status === SubscriptionStatus.ACTIVE &&
      (plan?.priceAmount ?? 0) > 0 &&
      subscription.currentPeriodEnd.getTime() < Date.now();

    if (paidLapsed) {
      const freePlan = await planRepository.findFreeActivePlan();
      if (freePlan) {
        // The plan period is over — any admin-granted bonus goes with it.
        await subscriptionRepository.updateById(subscription._id, {
          $set: {
            plan: freePlan._id,
            currentPeriodStart: new Date(),
            currentPeriodEnd: addDays(new Date(), 3650),
          },
          $unset: { bonus: '' },
        });
        if (subscription.bonus) {
          await activityService.log({
            workspace: workspaceId,
            action: ActivityAction.ADMIN_BONUS_REMOVED,
            description: 'Bonus benefits removed automatically — the plan period ended',
            entityType: 'Subscription',
            entityId: subscription._id,
          });
        }
        await this.notifyWorkspaceOwner(
          workspaceId,
          `Your ${plan?.name ?? 'paid'} plan has ended`,
          'You are back on the Free plan. Renew anytime from Billing to restore your limits.'
        );
        return { allowed: true };
      }
      // No ₹0 plan to fall back to — pause access until they renew.
      await subscriptionRepository.updateById(subscription._id, {
        $set: { status: SubscriptionStatus.EXPIRED },
        $unset: { bonus: '' },
      });
      await this.notifyWorkspaceOwner(
        workspaceId,
        `Your ${plan?.name ?? ''} plan has ended`,
        'Automations are paused. Renew from Billing to keep replying automatically.'
      );
      return { allowed: false, reason: 'SUBSCRIPTION_INACTIVE' };
    }

    if (!ACCESS_STATUSES.includes(subscription.status)) {
      return {
        allowed: false,
        reason:
          subscription.status === SubscriptionStatus.EXPIRED
            ? 'TRIAL_EXPIRED'
            : 'SUBSCRIPTION_INACTIVE',
      };
    }
    return { allowed: true };
  }

  /** Bell-notify the workspace owner (best-effort; billing must never crash on this). */
  private async notifyWorkspaceOwner(
    workspaceId: string,
    title: string,
    body: string
  ): Promise<void> {
    try {
      const workspace = await workspaceRepository.findById(workspaceId);
      if (!workspace?.owner) return;
      await notificationRepository.create({
        workspace: workspace._id,
        user: workspace.owner,
        type: NotificationType.SYSTEM,
        title,
        body,
        link: '/billing',
      });
    } catch {
      // Non-fatal: the plan change itself already succeeded.
    }
  }

  /**
   * Resolve the workspace's current limits + feature entitlements from its
   * plan, including any admin-granted bonus on top (unlimited stays unlimited).
   */
  async getEntitlements(workspaceId: string): Promise<WorkspaceEntitlements> {
    const subscription = await subscriptionRepository.findByWorkspace(workspaceId);
    const plan = subscription?.plan as unknown as IPlan | null;
    if (!plan) return UNRESTRICTED;
    const bonus = subscription?.bonus;
    const boosted = (limit: number, extra: number) => (limit === -1 ? -1 : limit + extra);
    return {
      limits: {
        connectedAccounts: boosted(
          plan.limits?.connectedAccounts ?? -1,
          bonus?.connectedAccounts ?? 0
        ),
        automations: boosted(plan.limits?.automations ?? -1, bonus?.automations ?? 0),
        monthlyMessages: boosted(plan.limits?.monthlyMessages ?? -1, bonus?.monthlyMessages ?? 0),
        teamMembers: plan.limits?.teamMembers ?? -1,
      },
      entitlements: {
        studio: plan.entitlements?.studio ?? true,
        csvExport: plan.entitlements?.csvExport ?? true,
      },
    };
  }

  /**
   * Self-serve plan switch — upgrades AND downgrades activate instantly, no
   * payment step (Razorpay stays dormant until enabled). Paid plans get their
   * normal validity period, after which the lazy lapse check in
   * getAccessState() drops the workspace back to Free automatically.
   */
  async choosePlan(user: AuthUser, planId: string): Promise<ISubscription> {
    const plan = await planRepository.findById(planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');

    const now = new Date();
    // Bonuses are scoped to the plan they were granted on; switching drops them.
    const previous = await subscriptionRepository.findByWorkspace(user.workspaceId);
    // Free never lapses; paid plans run for their interval/durationDays.
    const periodEnd = plan.priceAmount > 0 ? planPeriodEnd(plan, now) : addDays(now, 3650);
    const updated = await subscriptionRepository.updateOne(
      { workspace: user.workspaceId },
      {
        $set: {
          plan: plan._id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
        },
        $unset: { trialEndsAt: '', trialEndingNotifiedAt: '', bonus: '' },
      },
      { new: true, upsert: true }
    );

    if (previous?.bonus) {
      await activityService.log({
        workspace: user.workspaceId,
        action: ActivityAction.ADMIN_BONUS_REMOVED,
        description: 'Bonus benefits removed automatically — the plan was changed',
        entityType: 'Subscription',
        entityId: previous._id,
      });
    }

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.ADMIN_SUBSCRIPTION_UPDATED,
      description: `${user.email} switched to the ${plan.name} plan (self-serve)`,
      entityType: 'Subscription',
    });
    return (await subscriptionRepository.findByWorkspace(user.workspaceId)) ?? updated!;
  }

  /**
   * Step 1 of Razorpay checkout: create a gateway order for the plan.
   * The client opens Razorpay Checkout against this order id.
   */
  async createCheckout(
    user: AuthUser,
    planId: string
  ): Promise<{
    orderId: string;
    amount: number;
    currency: string;
    keyId: string;
    planName: string;
  }> {
    const plan = await planRepository.findById(planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');
    if (plan.priceAmount <= 0) {
      throw new BadRequestError('This plan is free — switch to it directly');
    }

    const order = await paymentService.createOrder({
      amount: plan.priceAmount,
      currency: plan.currency || 'INR',
      // Receipt must be <= 40 chars for Razorpay.
      receipt: `ws-${user.workspaceId.slice(-12)}-${Date.now().toString(36)}`,
      notes: { workspaceId: user.workspaceId, planId: plan._id.toString(), email: user.email },
    });

    return { ...order, keyId: paymentService.keyId, planName: plan.name };
  }

  /**
   * Step 2: verify the checkout signature, then activate the plan and record
   * the payment + a paid invoice. Called by the client after Razorpay's
   * success handler fires.
   */
  async verifyCheckout(
    user: AuthUser,
    params: {
      planId: string;
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    }
  ): Promise<ISubscription> {
    const plan = await planRepository.findById(params.planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');

    paymentService.verifyCheckoutSignature(
      params.razorpayOrderId,
      params.razorpayPaymentId,
      params.razorpaySignature
    );

    // Idempotency: a replayed verify call must not double-extend the period.
    const existing = await paymentRepository.findOne({
      providerPaymentId: params.razorpayPaymentId,
    });
    if (existing) {
      const current = await subscriptionRepository.findByWorkspace(user.workspaceId);
      if (current) return current;
    }

    const now = new Date();
    const periodEnd = planPeriodEnd(plan, now);

    const subscription = await subscriptionRepository.updateOne(
      { workspace: user.workspaceId },
      {
        $set: {
          plan: plan._id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
        },
        $unset: { trialEndsAt: '', trialEndingNotifiedAt: '', bonus: '' },
      },
      { new: true, upsert: true }
    );

    const payment = await paymentRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      amount: plan.priceAmount,
      currency: plan.currency || 'INR',
      status: PaymentStatus.SUCCEEDED,
      provider: 'razorpay',
      providerPaymentId: params.razorpayPaymentId,
      method: 'razorpay',
      paidAt: now,
    });

    await invoiceRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      subscription: subscription?._id,
      number: `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${payment._id.toString().slice(-6).toUpperCase()}`,
      status: InvoiceStatus.PAID,
      amountDue: plan.priceAmount,
      amountPaid: plan.priceAmount,
      currency: plan.currency || 'INR',
      lineItems: [{ description: `${plan.name} plan`, quantity: 1, unitAmount: plan.priceAmount }],
      periodStart: now,
      periodEnd,
      paidAt: now,
    });

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.ADMIN_SUBSCRIPTION_UPDATED,
      description: `${user.email} upgraded to ${plan.name} via Razorpay (${params.razorpayPaymentId})`,
      entityType: 'Subscription',
    });

    return (await subscriptionRepository.findByWorkspace(user.workspaceId)) ?? subscription!;
  }

  /**
   * "I want this paid plan" — notifies every super admin in-app so they can
   * collect payment off-platform and activate it from Admin → Billing.
   */
  async requestUpgrade(user: AuthUser, planId: string): Promise<void> {
    const plan = await planRepository.findById(planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');

    const admins = await userRepository.find({ isSuperAdmin: true }, '_id workspace');
    await Promise.all(
      admins.map((admin) =>
        notificationRepository.create({
          workspace: admin.workspace,
          user: admin._id,
          type: NotificationType.SYSTEM,
          title: `Upgrade request: ${plan.name}`,
          body: `${user.email} wants the ${plan.name} plan. Activate it from Admin → Billing after payment.`,
          link: '/admin/subscriptions',
        })
      )
    );

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.ADMIN_SUBSCRIPTION_UPDATED,
      description: `${user.email} requested an upgrade to the ${plan.name} plan`,
      entityType: 'Subscription',
    });
  }
}

export const subscriptionService = new SubscriptionService();

/**
 * Route guard: 403 SUBSCRIPTION_EXPIRED when the workspace's trial has lapsed
 * (or the subscription is canceled/expired). Must run after `authenticate`.
 * Applied to "growth" mutations — creating/activating automations, connecting
 * accounts — while reads and manual inbox replies stay available.
 */
export async function requireActiveSubscription(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const state = await subscriptionService.getAccessState(req.user!.workspaceId);
    if (!state.allowed) {
      throw new AppError(
        state.reason === 'TRIAL_EXPIRED'
          ? 'Your free trial has ended. Choose a plan to keep going.'
          : 'Your subscription is inactive. Choose a plan to continue.',
        HttpStatus.FORBIDDEN,
        { errorCode: 'SUBSCRIPTION_EXPIRED' }
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Route guard: 403 FEATURE_NOT_IN_PLAN when the workspace's plan does not
 * include the given entitlement. Must run after `authenticate`.
 */
export function requireEntitlement(key: keyof WorkspaceEntitlements['entitlements']) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { entitlements } = await subscriptionService.getEntitlements(req.user!.workspaceId);
      if (!entitlements[key]) {
        throw new AppError(
          'Your plan does not include this feature. Upgrade to unlock it.',
          HttpStatus.FORBIDDEN,
          {
            errorCode: 'FEATURE_NOT_IN_PLAN',
          }
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
