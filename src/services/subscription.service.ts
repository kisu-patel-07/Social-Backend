import { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import {
  ActivityAction,
  BillingInterval,
  InvoiceStatus,
  MessageDirection,
  MessageStatus,
  NotificationType,
  PaymentStatus,
  SubscriptionStatus,
} from '../constants';
import { HttpStatus } from '../constants/httpStatus';
import { env, isProduction } from '../config/env';
import { logger } from '../config/logger';
import { IPlan } from '../models/plan.model';
import { ISubscription } from '../models/subscription.model';
import { IInvoice } from '../models/invoice.model';
import {
  invoiceRepository,
  messageRepository,
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
  reason?: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_INACTIVE' | 'NO_PLAN';
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

/** Permissive defaults for unseeded DEV setups only (never used in production). */
const UNRESTRICTED: WorkspaceEntitlements = {
  limits: { connectedAccounts: -1, automations: -1, monthlyMessages: -1, teamMembers: -1 },
  entitlements: { studio: true, csvExport: true },
};

/** A workspace with no subscription: nothing is included until a plan is chosen. */
const NO_PLAN: WorkspaceEntitlements = {
  limits: { connectedAccounts: 0, automations: 0, monthlyMessages: 0, teamMembers: 0 },
  entitlements: { studio: false, csvExport: false },
};

/**
 * Conservative floor applied in PRODUCTION when a workspace has no plan (e.g. it
 * signed up before plans were seeded, or its subscription doc was removed). The
 * real Free plan is preferred; this is the last resort so a missing document can
 * never grant unlimited usage — a fail-safe, not a fail-open.
 */
const FREE_FALLBACK: WorkspaceEntitlements = {
  limits: { connectedAccounts: 1, automations: 2, monthlyMessages: 100, teamMembers: 1 },
  entitlements: { studio: false, csvExport: false },
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
  /**
   * Plans a customer may actually buy right now. A paid plan is hidden until it
   * has been synced to Razorpay (Admin → Plans → Sync), because without a
   * gateway plan there is nothing to charge against — showing it would mean a
   * checkout that always fails. Free plans need no gateway and always show.
   *
   * When Razorpay isn't configured at all the app falls back to the manual
   * "request upgrade" flow, which works without a gateway plan — so in that
   * mode paid plans stay visible rather than emptying the pricing page.
   */
  async listPlans(): Promise<IPlan[]> {
    const plans = await planRepository.listActive();
    if (!paymentService.isConfigured()) return plans;
    return plans.filter((plan) => plan.priceAmount === 0 || Boolean(plan.razorpayPlanId));
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
   * with no subscription document have no plan yet and are blocked.
   */
  async getAccessState(workspaceId: string): Promise<AccessState> {
    const subscription = await subscriptionRepository.findByWorkspace(workspaceId);
    // New accounts start with NO subscription at all: nothing runs until the
    // user picks a plan from Billing. (This used to fail open for dev setups —
    // now that "no plan" is a real product state, it must block.)
    if (!subscription) return { allowed: false, reason: 'NO_PLAN' };

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

    // Paid period lapsed without renewal → mark the subscription EXPIRED but
    // PRESERVE its plan reference. We deliberately do NOT rewrite `plan` to Free:
    // that was a silent, irreversible downgrade that also misfired on a stale or
    // clock-skewed `currentPeriodEnd` (e.g. after a cross-environment DB copy),
    // pinning paying customers to Free features with no audit trail. Keeping the
    // plan makes the state visible ("Pro — expired") in admin and recoverable on
    // renewal (choosePlan/verifyCheckout set status ACTIVE + a fresh period).
    const plan = subscription.plan as unknown as IPlan | null;
    const paidLapsed =
      subscription.status === SubscriptionStatus.ACTIVE &&
      (plan?.priceAmount ?? 0) > 0 &&
      subscription.currentPeriodEnd.getTime() < Date.now();

    if (paidLapsed) {
      // A plan the user cancelled ends as CANCELED (their choice, ran to term);
      // one that simply lapsed ends as EXPIRED. Neither grants access.
      const endedByChoice = subscription.cancelAtPeriodEnd === true;
      // The plan period is over — any admin-granted bonus goes with it.
      await subscriptionRepository.updateById(subscription._id, {
        $set: {
          status: endedByChoice ? SubscriptionStatus.CANCELED : SubscriptionStatus.EXPIRED,
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
        endedByChoice
          ? 'Your cancellation is now complete and automations are paused. You can start a plan again any time from Billing.'
          : 'Automations are paused. Renew from Billing to restore your plan.'
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
   * Bell-notify the owner that automated replies are paused (monthly quota
   * spent, or the subscription lapsed). The webhook pipeline calls this on
   * every skipped event, so it dedupes to one notification per cause per 24h.
   * Best-effort: must never break event processing.
   */
  async notifyAutomationsPaused(
    workspaceId: string,
    cause: 'quota' | 'subscription'
  ): Promise<void> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const already = await notificationRepository.count({
        workspace: workspaceId,
        'metadata.kind': 'automation_paused',
        'metadata.cause': cause,
        createdAt: { $gte: since },
      });
      if (already > 0) return;

      const workspace = await workspaceRepository.findById(workspaceId);
      if (!workspace?.owner) return;

      let body =
        'Your subscription is inactive, so automated replies are paused. Choose a plan in Billing to resume.';
      if (cause === 'quota') {
        const quota = await this.getMessageQuota(workspaceId);
        body = `You've used all ${quota.limit} replies included in your plan this month, so automated replies are paused. Upgrade your plan to resume them.`;
      }

      await notificationRepository.create({
        workspace: workspace._id,
        user: workspace.owner,
        type: NotificationType.SYSTEM,
        title: 'Automated replies are paused',
        body,
        link: '/billing',
        metadata: { kind: 'automation_paused', cause },
      });
    } catch (err) {
      logger.warn('Failed to create automation-paused notification', {
        workspaceId,
        cause,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Resolve the workspace's current limits + feature entitlements from its
   * plan, including any admin-granted bonus on top (unlimited stays unlimited).
   */
  async getEntitlements(workspaceId: string): Promise<WorkspaceEntitlements> {
    const subscription = await subscriptionRepository.findByWorkspace(workspaceId);
    // No subscription = the user hasn't picked a plan yet — nothing included,
    // so meters honestly show 0 and every gate stays closed.
    if (!subscription) return NO_PLAN;

    const plan = subscription.plan as unknown as IPlan | null;
    if (!plan) {
      // A subscription whose `plan` reference no longer resolves is a data-integrity
      // problem — most commonly a subscription copied across databases pointing at a
      // plan _id that was never seeded there. Historically this SILENTLY served Free
      // to a paying customer (the "paid Pro but got Regular features" bug). Log loudly
      // so it surfaces in monitoring/admin instead of degrading quietly. Run
      // `npm run subs:check` to list every affected subscription.
      logger.error('Subscription plan reference did not resolve — serving fallback entitlements', {
        workspaceId,
        subscriptionId: String(subscription._id),
        status: subscription.status,
      });
      // Stay permissive in unseeded dev; in production fail SAFE to the real
      // Free plan (or a conservative floor) so a broken reference can never
      // hand out unlimited usage.
      if (!isProduction) return UNRESTRICTED;
      const freePlan = await planRepository.findFreeActivePlan();
      return freePlan ? this.entitlementsFromPlan(freePlan) : FREE_FALLBACK;
    }
    return this.entitlementsFromPlan(plan, subscription.bonus);
  }

  /** Build a workspace's limits + feature switches from a plan (+ optional bonus). */
  private entitlementsFromPlan(
    plan: IPlan,
    bonus?: { connectedAccounts?: number; automations?: number; monthlyMessages?: number }
  ): WorkspaceEntitlements {
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
   * Outbound message usage in the CURRENT BILLING PERIOD vs the plan limit.
   * The window is the subscription's current period start (the plan's start /
   * last renewal date) through now, so the quota resets each period on the
   * plan's own date — e.g. a 30-day plan bought on the 4th counts from the 4th
   * — rather than on the calendar month. Single source of truth for the reply
   * quota (automation engines skip+log, and manual inbox replies 403).
   *
   * Both the automated public reply and the DM count (one unit each).
   */
  async getMessageQuota(
    workspaceId: string
  ): Promise<{ sent: number; limit: number; exceeded: boolean }> {
    const { limits } = await this.getEntitlements(workspaceId);
    if (limits.monthlyMessages === -1) return { sent: 0, limit: -1, exceeded: false };

    const subscription = await subscriptionRepository.findByWorkspace(workspaceId);
    // Count from the current period's start; fall back to the calendar month
    // only when there is no subscription record (unseeded/dev).
    let windowStart = subscription?.currentPeriodStart;
    if (!windowStart) {
      windowStart = new Date();
      windowStart.setDate(1);
      windowStart.setHours(0, 0, 0, 0);
    }
    const sent = await messageRepository.count({
      workspace: workspaceId,
      direction: MessageDirection.OUTBOUND,
      // Failed sends never reached anyone, so they must not consume quota.
      status: { $ne: MessageStatus.FAILED },
      createdAt: { $gte: windowStart },
    });
    return { sent, limit: limits.monthlyMessages, exceeded: sent >= limits.monthlyMessages };
  }

  /**
   * Gate for manual replies (inbox DMs + comment replies): the subscription
   * must be usable and the monthly reply quota not yet spent. Throws the same
   * error codes the rest of the platform uses so the client can react uniformly.
   */
  async assertCanSendManualReply(workspaceId: string): Promise<void> {
    const access = await this.getAccessState(workspaceId);
    if (!access.allowed) {
      throw new AppError(
        access.reason === 'NO_PLAN'
          ? "You don't have an active plan yet. Choose one from Billing to start replying."
          : 'Your subscription is inactive. Choose a plan from Billing to keep replying.',
        HttpStatus.FORBIDDEN,
        { errorCode: 'SUBSCRIPTION_EXPIRED' }
      );
    }
    const quota = await this.getMessageQuota(workspaceId);
    if (quota.exceeded) {
      throw new AppError(
        `You've used all ${quota.limit} replies included in your plan this month. Upgrade your plan to keep replying.`,
        HttpStatus.FORBIDDEN,
        { errorCode: 'PLAN_LIMIT_REACHED' }
      );
    }
  }

  /**
   * Self-serve switch to a FREE plan (instant, no charge). Paid plans must go
   * through checkout/subscription — activating them here would hand out paid
   * periods for free (payments are live now, so money must match access).
   */
  async choosePlan(user: AuthUser, planId: string): Promise<ISubscription> {
    const plan = await planRepository.findById(planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');
    if (plan.priceAmount > 0 && paymentService.isConfigured()) {
      throw new BadRequestError(
        `${plan.name} is a paid plan — complete the payment from Billing to activate it.`
      );
    }

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
   * Cancel the current plan at the END of the paid period — never mid-term.
   * The subscription stays ACTIVE (full access, automations keep running) until
   * `currentPeriodEnd`; the lapse check in getAccessState() then closes it as
   * CANCELED. Nothing is refunded: the user keeps what they already paid for.
   * Reversible with resumePlan() while the period is still running.
   */
  async cancelPlan(user: AuthUser): Promise<ISubscription> {
    const subscription = await subscriptionRepository.findByWorkspace(user.workspaceId);
    if (!subscription) throw new NotFoundError('Subscription not found');

    const plan = subscription.plan as unknown as IPlan | null;
    if ((plan?.priceAmount ?? 0) === 0) {
      throw new BadRequestError(
        "You're on a free plan, so there's nothing to cancel. You can switch plans any time."
      );
    }
    if (!ACCESS_STATUSES.includes(subscription.status)) {
      throw new BadRequestError('This plan has already ended, so there is nothing to cancel.');
    }
    if (subscription.cancelAtPeriodEnd) {
      throw new BadRequestError('This plan is already set to end — no further action is needed.');
    }

    // Stop the mandate FIRST when this is an auto-renewing subscription. If
    // Razorpay refuses, we must NOT mark it cancelled locally — otherwise the
    // app would say "cancelled" while the customer keeps getting charged.
    if (subscription.externalSubscriptionId) {
      await paymentService.cancelSubscription(subscription.externalSubscriptionId, true);
    }

    const updated = await subscriptionRepository.updateById(subscription._id, {
      $set: { cancelAtPeriodEnd: true, canceledAt: new Date() },
    });

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.SUBSCRIPTION_CANCELED,
      description: `${user.email} cancelled the ${plan?.name ?? 'paid'} plan (ends ${subscription.currentPeriodEnd.toISOString().slice(0, 10)})`,
      entityType: 'Subscription',
      entityId: subscription._id,
    });

    await this.notifyWorkspaceOwner(
      user.workspaceId,
      'Your plan is set to end',
      `${plan?.name ?? 'Your plan'} stays active until ${subscription.currentPeriodEnd.toISOString().slice(0, 10)} and won't renew. Changed your mind? Reactivate it from Billing.`
    );

    return (await subscriptionRepository.findByWorkspace(user.workspaceId)) ?? updated!;
  }

  /** Undo a pending cancellation while the paid period is still running. */
  async resumePlan(user: AuthUser): Promise<ISubscription> {
    const subscription = await subscriptionRepository.findByWorkspace(user.workspaceId);
    if (!subscription) throw new NotFoundError('Subscription not found');

    if (!subscription.cancelAtPeriodEnd) {
      throw new BadRequestError('This plan is not scheduled to end, so there is nothing to undo.');
    }
    if (subscription.currentPeriodEnd.getTime() < Date.now()) {
      throw new BadRequestError(
        'This plan has already ended. Choose it again from Billing to start a new period.'
      );
    }
    // A cancelled Razorpay mandate is terminal — it cannot be revived, only
    // replaced by a new subscription (which needs the customer to authorize
    // payment again). Say so instead of pretending the undo worked.
    if (subscription.externalSubscriptionId) {
      throw new BadRequestError(
        'Automatic renewal was stopped with your bank, so it cannot be switched back on. Choose your plan again from Billing to set up a new subscription.'
      );
    }

    const updated = await subscriptionRepository.updateById(subscription._id, {
      $set: { cancelAtPeriodEnd: false },
      $unset: { canceledAt: '' },
    });

    const plan = subscription.plan as unknown as IPlan | null;
    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.SUBSCRIPTION_RESUMED,
      description: `${user.email} reactivated the ${plan?.name ?? 'paid'} plan`,
      entityType: 'Subscription',
      entityId: subscription._id,
    });

    return (await subscriptionRepository.findByWorkspace(user.workspaceId)) ?? updated!;
  }

  /**
   * How many cycles to authorize on a Razorpay subscription. Razorpay requires
   * a finite count, so we authorize ~10 years' worth (capped at its limit) —
   * long enough that renewals never silently stop for an active customer.
   */
  private subscriptionCycles(plan: IPlan): number {
    if (plan.interval === BillingInterval.YEARLY) return 10;
    if (plan.interval === BillingInterval.DAYS) {
      const days = plan.durationDays ?? 30;
      return Math.max(1, Math.min(100, Math.floor(3650 / days)));
    }
    return 120; // monthly
  }

  /**
   * Start an AUTO-RENEWING subscription for a plan: Razorpay collects a mandate
   * once (UPI Autopay / card e-mandate) and then charges every cycle by itself.
   * Each charge arrives as a `subscription.charged` webhook that extends the
   * period, so the workspace never lapses. Requires the plan to be synced with
   * `npm run razorpay:sync-plans`.
   */
  async createSubscriptionCheckout(
    user: AuthUser,
    planId: string
  ): Promise<{
    subscriptionId: string;
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
    if (!plan.razorpayPlanId) {
      throw new BadRequestError(
        'Automatic renewal is not set up for this plan yet. Please choose the one-time payment option.'
      );
    }

    const { subscriptionId } = await paymentService.createSubscription({
      razorpayPlanId: plan.razorpayPlanId,
      totalCount: this.subscriptionCycles(plan),
      // `app` separates this app's activity in a shared Razorpay account; the
      // rest routes the recurring webhooks back to the right workspace/plan.
      notes: {
        app: env.APP_ID,
        workspaceId: user.workspaceId,
        planId: plan._id.toString(),
        email: user.email,
      },
    });

    return {
      subscriptionId,
      amount: plan.priceAmount,
      currency: plan.currency || 'INR',
      keyId: paymentService.keyId,
      planName: plan.name,
    };
  }

  /**
   * Confirm the first charge of an auto-renewing subscription and activate the
   * plan. Later cycles need no client involvement — they arrive as webhooks.
   */
  async verifySubscriptionCheckout(
    user: AuthUser,
    params: {
      planId: string;
      razorpayPaymentId: string;
      razorpaySubscriptionId: string;
      razorpaySignature: string;
    }
  ): Promise<ISubscription> {
    const plan = await planRepository.findById(params.planId);
    if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');

    paymentService.verifySubscriptionSignature(
      params.razorpayPaymentId,
      params.razorpaySubscriptionId,
      params.razorpaySignature
    );

    return this.recordPaidActivation({
      workspaceId: user.workspaceId,
      plan,
      razorpayPaymentId: params.razorpayPaymentId,
      razorpaySubscriptionId: params.razorpaySubscriptionId,
      actor: { userId: user.id, email: user.email },
    });
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
      // `app` separates this app's payments in the shared Razorpay dashboard.
      notes: {
        app: env.APP_ID,
        workspaceId: user.workspaceId,
        planId: plan._id.toString(),
        email: user.email,
      },
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

    return this.recordPaidActivation({
      workspaceId: user.workspaceId,
      plan,
      razorpayOrderId: params.razorpayOrderId,
      razorpayPaymentId: params.razorpayPaymentId,
      actor: { userId: user.id, email: user.email },
    });
  }

  /**
   * Idempotently record a successful paid activation: set the subscription ACTIVE
   * for a fresh period and create the payment + invoice. Safe to call from BOTH
   * the client verify flow and the Razorpay webhook — whichever arrives first
   * wins; the loser is a no-op, guarded by the unique providerPaymentId index.
   */
  private async recordPaidActivation(params: {
    workspaceId: string;
    plan: IPlan;
    razorpayOrderId?: string;
    razorpayPaymentId: string;
    /** Set on auto-renewing plans so future cycles can be matched back. */
    razorpaySubscriptionId?: string;
    /** Cycle window from Razorpay on a renewal; defaults to "now + interval". */
    periodStart?: Date;
    periodEnd?: Date;
    actor?: { userId?: string; email?: string };
  }): Promise<ISubscription> {
    const { workspaceId, plan } = params;

    const currentSubscription = async (): Promise<ISubscription> =>
      (await subscriptionRepository.findByWorkspace(workspaceId)) ??
      (await subscriptionRepository.findOne({ workspace: workspaceId }))!;

    // Fast path for the common replay (webhook arriving after client verify ran).
    const already = await paymentRepository.findOne({
      providerPaymentId: params.razorpayPaymentId,
    });
    if (already) return currentSubscription();

    const now = new Date();
    // Razorpay tells us the exact cycle window on a renewal; fall back to our
    // own interval maths for one-time (manual) payments.
    const periodStart = params.periodStart ?? now;
    const periodEnd = params.periodEnd ?? planPeriodEnd(plan, periodStart);

    // Create the payment FIRST so the unique providerPaymentId index rejects a
    // concurrent duplicate (client-verify + webhook race) before we do the rest.
    let payment;
    try {
      payment = await paymentRepository.create({
        workspace: new Types.ObjectId(workspaceId),
        app: env.APP_ID,
        plan: plan._id,
        amount: plan.priceAmount,
        currency: plan.currency || 'INR',
        status: PaymentStatus.SUCCEEDED,
        provider: 'razorpay',
        providerPaymentId: params.razorpayPaymentId,
        providerOrderId: params.razorpayOrderId,
        method: 'razorpay',
        paidAt: now,
      });
    } catch (error) {
      // Duplicate key ⇒ the other path won the race and already recorded it.
      if ((error as { code?: number }).code === 11000) return currentSubscription();
      throw error;
    }

    const subscription = await subscriptionRepository.updateOne(
      { workspace: workspaceId },
      {
        $set: {
          plan: plan._id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          ...(params.razorpaySubscriptionId
            ? { externalSubscriptionId: params.razorpaySubscriptionId }
            : {}),
        },
        $unset: { trialEndsAt: '', trialEndingNotifiedAt: '', bonus: '', canceledAt: '' },
      },
      { new: true, upsert: true }
    );

    // Link the payment to the subscription now that it exists.
    await paymentRepository.updateById(payment._id, {
      $set: { subscription: subscription?._id },
    });

    await invoiceRepository.create({
      workspace: new Types.ObjectId(workspaceId),
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
      workspace: workspaceId,
      user: params.actor?.userId,
      action: ActivityAction.ADMIN_SUBSCRIPTION_UPDATED,
      description: `${params.actor?.email ?? 'Payment'} activated the ${plan.name} plan via Razorpay (${params.razorpayPaymentId})`,
      entityType: 'Subscription',
    });

    return currentSubscription();
  }

  /**
   * Handle a verified Razorpay webhook event. Acts on `payment.captured` to
   * activate the plan server-side — the safety net for when the browser closed
   * before client verify completed. Idempotent via recordPaidActivation, and it
   * ignores payments belonging to other apps that share this Razorpay account.
   */
  async handleRazorpayWebhook(event: {
    event?: string;
    payload?: {
      payment?: {
        entity?: {
          id?: string;
          order_id?: string;
          invoice_id?: string;
          notes?: Record<string, string>;
        };
      };
      subscription?: {
        entity?: {
          id?: string;
          current_start?: number;
          current_end?: number;
          notes?: Record<string, string>;
        };
      };
    };
  }): Promise<void> {
    switch (event.event) {
      case 'subscription.charged':
        return this.handleSubscriptionCharged(event);
      case 'subscription.cancelled':
        return this.handleSubscriptionEnded(event, 'cancelled');
      case 'subscription.halted':
        return this.handleSubscriptionEnded(event, 'halted');
      case 'subscription.pending':
        return this.handleSubscriptionPending(event);
      case 'payment.captured':
        break;
      default:
        return;
    }

    const entity = event.payload?.payment?.entity;
    if (!entity?.id || !entity.order_id) return;
    // Recurring charges also emit payment.captured, but they carry an invoice
    // and are owned by subscription.charged — skip them here.
    if (entity.invoice_id) return;

    const notes = entity.notes ?? {};
    if (notes.app && notes.app !== env.APP_ID) return; // another app's payment
    const { workspaceId, planId } = notes;
    if (!workspaceId || !planId) {
      logger.warn('Razorpay webhook payment.captured missing routing notes', {
        paymentId: entity.id,
      });
      return;
    }

    const plan = await planRepository.findById(planId);
    if (!plan) {
      logger.error('Razorpay webhook: plan not found for captured payment', {
        planId,
        paymentId: entity.id,
      });
      return;
    }

    await this.recordPaidActivation({
      workspaceId,
      plan,
      razorpayOrderId: entity.order_id,
      razorpayPaymentId: entity.id,
    });
    logger.info('Razorpay webhook activated plan', { workspaceId, planId, paymentId: entity.id });
  }

  /**
   * THE auto-renewal path: Razorpay charged the saved mandate for a new cycle.
   * Extends the period with the exact window Razorpay reports, so an active
   * customer never lapses and needs to do nothing.
   */
  private async handleSubscriptionCharged(event: {
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string } };
      subscription?: {
        entity?: {
          id?: string;
          current_start?: number;
          current_end?: number;
          notes?: Record<string, string>;
        };
      };
    };
  }): Promise<void> {
    const sub = event.payload?.subscription?.entity;
    const payment = event.payload?.payment?.entity;
    if (!sub?.id || !payment?.id) return;

    const notes = sub.notes ?? {};
    if (notes.app && notes.app !== env.APP_ID) return; // another app's subscription
    const { workspaceId, planId } = notes;
    if (!workspaceId || !planId) {
      logger.warn('Razorpay subscription.charged missing routing notes', {
        subscriptionId: sub.id,
      });
      return;
    }

    const plan = await planRepository.findById(planId);
    if (!plan) {
      logger.error('Razorpay subscription.charged: plan not found', { planId, id: sub.id });
      return;
    }

    await this.recordPaidActivation({
      workspaceId,
      plan,
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id,
      razorpaySubscriptionId: sub.id,
      periodStart: sub.current_start ? new Date(sub.current_start * 1000) : undefined,
      periodEnd: sub.current_end ? new Date(sub.current_end * 1000) : undefined,
    });
    logger.info('Razorpay subscription renewed', {
      workspaceId,
      planId,
      subscriptionId: sub.id,
      paymentId: payment.id,
    });
  }

  /** Look up the local subscription a Razorpay subscription id belongs to. */
  private async findByRazorpaySubscription(id: string): Promise<ISubscription | null> {
    return subscriptionRepository.findOne({ externalSubscriptionId: id });
  }

  /**
   * Razorpay stopped the mandate — either the customer cancelled it there, or
   * every retry for a failed charge was exhausted ("halted"). Either way there
   * will be no further charges: flag it so the period runs out and ends, and
   * tell the owner while they still have access.
   */
  private async handleSubscriptionEnded(
    event: { payload?: { subscription?: { entity?: { id?: string } } } },
    reason: 'cancelled' | 'halted'
  ): Promise<void> {
    const id = event.payload?.subscription?.entity?.id;
    if (!id) return;
    const subscription = await this.findByRazorpaySubscription(id);
    if (!subscription) return;

    if (!subscription.cancelAtPeriodEnd) {
      await subscriptionRepository.updateById(subscription._id, {
        $set: { cancelAtPeriodEnd: true, canceledAt: new Date() },
      });
    }

    await this.notifyWorkspaceOwner(
      subscription.workspace.toString(),
      reason === 'halted' ? "We couldn't collect your payment" : 'Automatic renewal stopped',
      reason === 'halted'
        ? 'Your bank declined the renewal, so your plan will not continue. Your current period still works — set up payment again from Billing to stay active.'
        : "Your plan won't renew automatically any more. It stays active until the current period ends."
    );
    logger.info('Razorpay subscription ended', { subscriptionId: id, reason });
  }

  /** A scheduled charge failed; Razorpay will retry. Nudge the owner early. */
  private async handleSubscriptionPending(event: {
    payload?: { subscription?: { entity?: { id?: string } } };
  }): Promise<void> {
    const id = event.payload?.subscription?.entity?.id;
    if (!id) return;
    const subscription = await this.findByRazorpaySubscription(id);
    if (!subscription) return;

    await this.notifyWorkspaceOwner(
      subscription.workspace.toString(),
      'Your renewal payment did not go through',
      "We'll try again shortly. To avoid any interruption, check that your payment method is active and has sufficient balance."
    );
    logger.info('Razorpay subscription payment pending retry', { subscriptionId: id });
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
        state.reason === 'NO_PLAN'
          ? "You don't have an active plan yet. Choose one from Billing to get started."
          : state.reason === 'TRIAL_EXPIRED'
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
