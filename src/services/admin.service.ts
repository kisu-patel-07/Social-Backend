import crypto from 'crypto';
import { FilterQuery, PipelineStage, Types } from 'mongoose';
import {
  ActivityAction,
  AuthProvider,
  AutomationStatus,
  BillingInterval,
  ContactMessageStatus,
  CouponType,
  MessageDirection,
  MessageStatus,
  NotificationType,
  PaymentStatus,
  Platform,
  StudioAutomationStatus,
  SubscriptionStatus,
  UserRole,
} from '../constants';
import { IContactMessage } from '../models/contactMessage.model';
import { IActivityLog } from '../models/activityLog.model';
import { IMessage } from '../models/message.model';
import { IPayment } from '../models/payment.model';
import { IInvoice } from '../models/invoice.model';
import { ICoupon, ICouponRedemption } from '../models/coupon.model';
import { IPlan } from '../models/plan.model';
import { ISocialAccount } from '../models/socialAccount.model';
import { ISubscription } from '../models/subscription.model';
import { IUser } from '../models/user.model';
import { IWorkspace } from '../models/workspace.model';
import { StudioAutomationModel } from '../models/studioAutomation.model';
import { ISystemBanner, SystemSettingModel } from '../models/systemSetting.model';
import { metaClient } from './meta';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { paymentService } from './payment.service';
import { planPeriodEnd } from './subscription.service';
import { signAccessToken } from '../utils/jwt';
import { buildTotpUri, generateTotpSecret, totpQrDataUrl, verifyTotpCode } from '../utils/totp';
import { hashPassword } from '../utils/password';
import { CsvColumn, toCsv } from '../utils/csv';
import { toDateKey } from '../utils/date';
import { containsRegex } from '../utils/text';
import { linkTrackingService } from './linkTracking.service';
import {
  activityLogRepository,
  automationRepository,
  contactMessageRepository,
  conversationRepository,
  couponRedemptionRepository,
  couponRepository,
  invoiceRepository,
  jobRunRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  notificationRepository,
  paymentRepository,
  planRepository,
  socialAccountRepository,
  studioAutomationRepository,
  subscriptionRepository,
  userRepository,
  workspaceRepository,
} from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/AppError';
import { addDays } from '../utils/date';
import { buildPaginationMeta } from '../utils/pagination';
import { activityService } from './activity.service';
import { authService } from './auth.service';
import { emailService } from './email/email.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Headline platform metrics for the admin overview page. */
export interface AdminOverview {
  users: {
    total: number;
    verified: number;
    suspended: number;
    newLast7Days: number;
    newLast30Days: number;
  };
  workspaces: number;
  accounts: { total: number; byPlatform: Record<string, number> };
  automations: { classicActive: number; studioActive: number };
  leads: number;
  messages: { today: number; failedToday: number; last30Days: number };
  subscriptions: { byStatus: Record<string, number>; mrrCents: number; currency: string };
  /** Daily signup + message counts for the trend chart (last 14 days). */
  daily: Array<{ date: string; signups: number; messages: number }>;
  recentSignups: Array<{
    id: string;
    name: string;
    email: string;
    isEmailVerified: boolean;
    createdAt: Date;
  }>;
}

interface AdminUserFilters extends PaginationOptions {
  search?: string;
  verified?: boolean;
  suspended?: boolean;
}

/** Everything the admin user-detail page needs in one request. */
export interface AdminUserDetail {
  user: IUser;
  workspace: IWorkspace | null;
  subscription: ISubscription | null;
  usage: {
    connectedAccounts: number;
    automations: number;
    studioAutomations: number;
    leads: number;
    messagesLast30Days: number;
  };
  recentActivity: IActivityLog[];
  /** Recent payments for this workspace (plan populated), newest first. */
  payments: IPayment[];
  /** Internal support notes — never serialized on the user doc itself. */
  adminNotes: string;
}

interface AdminSubscriptionFilters extends PaginationOptions {
  status?: SubscriptionStatus;
}

interface UpdateSubscriptionParams {
  planId?: string;
  status?: SubscriptionStatus;
  /** Push currentPeriodEnd (and trial end, while trialing) out by N days. */
  extendDays?: number;
}

interface PlanParams {
  code?: string;
  name?: string;
  description?: string;
  priceAmount?: number;
  currency?: string;
  interval?: BillingInterval;
  durationDays?: number;
  limits?: {
    connectedAccounts?: number;
    automations?: number;
    monthlyMessages?: number;
    teamMembers?: number;
  };
  entitlements?: {
    studio?: boolean;
    csvExport?: boolean;
  };
  features?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

interface AdminAutomationFilters extends PaginationOptions {
  status?: string;
  kind?: 'classic' | 'studio';
  search?: string;
}

/** Flattened row for the merged classic+studio automations list. */
export interface AdminAutomationRow {
  _id: Types.ObjectId;
  name: string;
  status: string;
  kind: 'classic' | 'studio';
  triggerCount: number;
  lastTriggeredAt?: Date;
  createdAt: Date;
  workspace?: { _id: Types.ObjectId; name?: string };
  socialAccount?: { _id: Types.ObjectId; name?: string; username?: string; platform?: Platform };
}

/** Everything the admin health page needs in one request. */
export interface AdminHealth {
  accounts: {
    total: number;
    webhookIssues: number;
    expiredTokens: number;
    expiringTokens: number;
  };
  /** Limited to 20 rows each; the counts above are the real totals. */
  webhookIssues: ISocialAccount[];
  expiredTokens: ISocialAccount[];
  expiringTokens: ISocialAccount[];
  messages: {
    sent24h: number;
    failed24h: number;
    failed7d: number;
    /** Percentage 0-100 of outbound messages that failed in the last 24h. */
    failureRate24h: number;
  };
  recentFailures: IMessage[];
  /** Last run of each scheduled job — a dead cron is otherwise invisible. */
  jobs: Array<{
    job: string;
    ok: boolean;
    summary?: string;
    lastRunAt: Date;
    durationMs: number;
  }>;
}

interface BroadcastParams {
  title: string;
  body: string;
  link?: string;
  audience: 'all' | 'verified';
  /** Restrict to workspaces on this plan (active/trialing). */
  planId?: string;
  /** Where to deliver: in-app bell, email (via Brevo), or both. Default bell. */
  channel?: 'bell' | 'email' | 'both';
}

/** Deep-dive metrics for the admin analytics page. */
export interface AdminAnalytics {
  /** 90-day daily series. */
  daily: Array<{ date: string; signups: number; messages: number; leads: number }>;
  planDistribution: Array<{ planId: string; code: string; name: string; count: number }>;
  topWorkspaces: Array<{ workspaceId: string; name: string; messages30d: number; leads: number }>;
  /**
   * Lifetime activation funnel: how far signups get. Each step is a subset of
   * the previous one in spirit (workspace-level checks from "connected" on).
   */
  funnel: Array<{ step: string; count: number }>;
  /** Collected revenue per month, last 12 months (SUCCEEDED payments, this app). */
  revenueMonthly: Array<{ month: string; amount: number; payments: number }>;
  /** New paid activations vs cancellations per month, last 12 months. */
  subscriberFlow: Array<{ month: string; started: number; cancelled: number }>;
  /** Currency the revenue series is denominated in (first seen; INR default). */
  currency: string;
}

/** One row in the admin subscription-lifecycle lists. */
export interface LifecycleRow {
  id: string;
  workspaceName: string;
  planName: string;
  priceAmount: number;
  currency: string;
  currentPeriodEnd: Date;
  canceledAt?: Date;
  /** True when a Razorpay mandate will charge automatically. */
  autoRenew: boolean;
  status: SubscriptionStatus;
}

/** Churn radar + renewal forecast + dunning for the admin Billing page. */
export interface AdminBillingInsights {
  /** Cancelled but still running — ends at currentPeriodEnd. */
  pendingCancellations: LifecycleRow[];
  /** Paid subscriptions whose period ends within the next 7 days. */
  upcomingRenewals: LifecycleRow[];
  /** Renewal charge failed; Razorpay is retrying (status PAST_DUE). */
  pastDue: LifecycleRow[];
}

/** Everything the admin workspace drill-in page needs in one request. */
export interface AdminWorkspaceDetail {
  workspace: IWorkspace;
  members: IUser[];
  accounts: ISocialAccount[];
  subscription: ISubscription | null;
  usage: {
    automations: number;
    studioAutomations: number;
    leads: number;
    messages30d: number;
  };
}

/** A row in the admin workspaces directory. */
export interface AdminWorkspaceRow {
  _id: Types.ObjectId;
  name: string;
  createdAt: Date;
  memberCount: number;
  accountCount: number;
  subscriptionStatus?: string;
  plan?: { code?: string; name?: string };
  owner?: { _id?: Types.ObjectId; name?: string; email?: string };
}

/** UTC day key (YYYY-MM-DD) used to bucket daily aggregates. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Platform-operator surface behind /api/admin. Every method here crosses
 * workspace boundaries by design; routes must be gated by requireSuperAdmin.
 */
class AdminService {
  // ---- Overview -------------------------------------------------------------

  async getOverview(): Promise<AdminOverview> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const days7 = new Date(now.getTime() - 7 * DAY_MS);
    const days14 = new Date(now.getTime() - 14 * DAY_MS);
    const days30 = new Date(now.getTime() - 30 * DAY_MS);

    const [
      totalUsers,
      verifiedUsers,
      suspendedUsers,
      newLast7Days,
      newLast30Days,
      workspaces,
      totalAccounts,
      accountsByPlatform,
      classicActive,
      studioActive,
      leads,
      messagesToday,
      failedToday,
      messagesLast30Days,
      subsByStatus,
      activeSubs,
      signupsDaily,
      messagesDaily,
      recentSignups,
    ] = await Promise.all([
      userRepository.count(),
      userRepository.count({ isEmailVerified: true }),
      userRepository.count({ isSuspended: true }),
      userRepository.count({ createdAt: { $gte: days7 } }),
      userRepository.count({ createdAt: { $gte: days30 } }),
      workspaceRepository.count(),
      socialAccountRepository.count(),
      socialAccountRepository.aggregate<{ _id: Platform; count: number }>([
        { $group: { _id: '$platform', count: { $sum: 1 } } },
      ]),
      automationRepository.count({ status: AutomationStatus.ACTIVE }),
      studioAutomationRepository.count({ status: StudioAutomationStatus.ACTIVE }),
      leadRepository.count(),
      messageRepository.count({ createdAt: { $gte: startOfToday } }),
      messageRepository.count({
        createdAt: { $gte: startOfToday },
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.FAILED,
      }),
      messageRepository.count({ createdAt: { $gte: days30 } }),
      subscriptionRepository.aggregate<{ _id: SubscriptionStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      subscriptionRepository.find(
        { status: { $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
        undefined,
        { populate: { path: 'plan', select: 'priceAmount interval' } }
      ),
      userRepository.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: days14 } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
      ]),
      messageRepository.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: days14 } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
      ]),
      userRepository.find({}, 'name email isEmailVerified createdAt', {
        sort: { createdAt: -1 },
        limit: 5,
      }),
    ]);

    // Monthly-normalized recurring revenue across paying (active/trialing) subs.
    const mrrCents = activeSubs.reduce((sum, sub) => {
      const plan = sub.plan as unknown as IPlan | null;
      if (!plan?.priceAmount) return sum;
      if (plan.interval === BillingInterval.YEARLY) return sum + Math.round(plan.priceAmount / 12);
      if (plan.interval === BillingInterval.DAYS) {
        return sum + Math.round((plan.priceAmount * 30) / (plan.durationDays || 30));
      }
      return sum + plan.priceAmount;
    }, 0);
    // Display currency for MRR: taken from the first paid plan (single-currency setup).
    const mrrCurrency =
      activeSubs
        .map((sub) => (sub.plan as unknown as IPlan | null)?.currency)
        .find((c) => Boolean(c)) ?? 'INR';

    const signupsByDay = new Map(signupsDaily.map((d) => [d._id, d.count]));
    const messagesByDay = new Map(messagesDaily.map((d) => [d._id, d.count]));
    const daily: AdminOverview['daily'] = [];
    for (let i = 13; i >= 0; i--) {
      const key = dayKey(new Date(now.getTime() - i * DAY_MS));
      daily.push({
        date: key,
        signups: signupsByDay.get(key) ?? 0,
        messages: messagesByDay.get(key) ?? 0,
      });
    }

    return {
      users: {
        total: totalUsers,
        verified: verifiedUsers,
        suspended: suspendedUsers,
        newLast7Days,
        newLast30Days,
      },
      workspaces,
      accounts: {
        total: totalAccounts,
        byPlatform: Object.fromEntries(accountsByPlatform.map((a) => [a._id, a.count])),
      },
      automations: { classicActive, studioActive },
      leads,
      messages: { today: messagesToday, failedToday, last30Days: messagesLast30Days },
      subscriptions: {
        byStatus: Object.fromEntries(subsByStatus.map((s) => [s._id, s.count])),
        mrrCents,
        currency: mrrCurrency,
      },
      daily,
      recentSignups: recentSignups.map((u) => ({
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        isEmailVerified: u.isEmailVerified,
        createdAt: u.createdAt,
      })),
    };
  }

  // ---- Users ----------------------------------------------------------------

  /** Shared filter builder for the users list and the filtered CSV export. */
  private buildUserFilter(filters: {
    search?: string;
    verified?: boolean;
    suspended?: boolean;
  }): FilterQuery<IUser> {
    const query: FilterQuery<IUser> = {};
    if (filters.verified !== undefined) query.isEmailVerified = filters.verified;
    if (filters.suspended !== undefined) query.isSuspended = filters.suspended;
    if (filters.search) {
      query.$or = [
        { name: containsRegex(filters.search) },
        { email: containsRegex(filters.search) },
      ];
    }
    return query;
  }

  listUsers(filters: AdminUserFilters): Promise<PaginatedResult<IUser>> {
    return userRepository.paginate(this.buildUserFilter(filters), filters, undefined, [
      { path: 'workspace', select: 'name' },
    ]);
  }

  /**
   * Apply one action to many users at once. Guarded per user: nobody can bulk-
   * suspend themselves or a super admin — those rows are skipped and counted,
   * not errors, so one protected row doesn't abort the whole batch.
   */
  async bulkUpdateUsers(
    actor: AuthUser,
    ids: string[],
    action: 'suspend' | 'unsuspend' | 'verify'
  ): Promise<{ affected: number; skipped: number }> {
    const users = await userRepository.find({ _id: { $in: ids } }, '_id isSuperAdmin');
    const eligible = users.filter(
      (u) => !(action === 'suspend' && (u.isSuperAdmin || u._id.toString() === actor.id))
    );
    const skipped = ids.length - eligible.length;
    const eligibleIds = eligible.map((u) => u._id);

    if (eligibleIds.length > 0) {
      if (action === 'suspend') {
        await userRepository.updateMany(
          { _id: { $in: eligibleIds } },
          {
            $set: { isSuspended: true, suspendedAt: new Date() },
            // Invalidate refresh tokens issued before the suspension.
            $inc: { tokenVersion: 1 },
          }
        );
      } else if (action === 'unsuspend') {
        await userRepository.updateMany(
          { _id: { $in: eligibleIds } },
          { $set: { isSuspended: false }, $unset: { suspendedAt: '' } }
        );
      } else {
        await userRepository.updateMany(
          { _id: { $in: eligibleIds } },
          {
            $set: { isEmailVerified: true },
            $unset: { emailOtpHash: '', emailOtpExpiresAt: '', emailOtpAttempts: '' },
          }
        );
      }
    }

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_USERS_BULK_UPDATED,
      description: `${actor.email} bulk-${action}ed ${eligibleIds.length} user(s)${skipped ? ` (${skipped} skipped)` : ''}`,
      metadata: { action, affected: eligibleIds.length, skipped },
    });

    return { affected: eligibleIds.length, skipped };
  }

  /**
   * Manually onboard a customer: verified user + workspace, an optional plan
   * granted immediately (admin power — paid plans allowed without payment),
   * and a set-your-password email so no credential ever travels by chat.
   */
  async createUser(
    actor: AuthUser,
    params: { name: string; email: string; planId?: string }
  ): Promise<IUser> {
    const email = params.email.toLowerCase().trim();
    const existing = await userRepository.findByEmail(email);
    if (existing) throw new ConflictError('An account with this email already exists');

    let plan: IPlan | null = null;
    if (params.planId) {
      plan = await planRepository.findById(params.planId);
      if (!plan || !plan.isActive) throw new NotFoundError('Plan not found');
    }

    // Same ordering as signup: pre-generate the user id so the workspace can
    // reference its owner before the user document exists.
    const userId = new Types.ObjectId();
    const workspace = await workspaceRepository.create({
      name: `${params.name}'s Workspace`,
      owner: userId,
    });
    // Random throwaway password — the user sets their real one via the email.
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
    const user = await userRepository.create({
      _id: userId,
      name: params.name,
      email,
      password: passwordHash,
      workspace: workspace._id,
      role: UserRole.OWNER,
      authProviders: [AuthProvider.LOCAL],
      isEmailVerified: true,
    });

    if (plan) {
      const now = new Date();
      await subscriptionRepository.create({
        workspace: workspace._id,
        plan: plan._id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: plan.priceAmount > 0 ? planPeriodEnd(plan, now) : addDays(now, 3650),
      });
    }

    // Set-password email (the normal reset flow); best-effort.
    await authService.forgotPassword(email);

    await activityService.log({
      workspace: workspace._id.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_USER_CREATED,
      description: `${actor.email} created user ${email}${plan ? ` on the ${plan.name} plan` : ' (no plan)'}`,
      entityType: 'User',
      entityId: user._id,
    });

    return user;
  }

  async getUserDetail(id: string): Promise<AdminUserDetail> {
    const user = await userRepository.findById(id, '+adminNotes');
    if (!user) throw new NotFoundError('User not found');

    const workspaceId = user.workspace;
    const days30 = new Date(Date.now() - 30 * DAY_MS);

    const [
      workspace,
      subscription,
      connectedAccounts,
      automations,
      studioAutomations,
      leads,
      messagesLast30Days,
      recentActivity,
      payments,
    ] = await Promise.all([
      workspaceRepository.findById(workspaceId),
      subscriptionRepository.findOne({ workspace: workspaceId }, undefined, {
        populate: { path: 'plan' },
      }),
      socialAccountRepository.count({ workspace: workspaceId }),
      automationRepository.count({ workspace: workspaceId }),
      studioAutomationRepository.count({ workspace: workspaceId }),
      leadRepository.count({ workspace: workspaceId }),
      messageRepository.count({ workspace: workspaceId, createdAt: { $gte: days30 } }),
      activityLogRepository.find({ workspace: workspaceId }, undefined, {
        sort: { createdAt: -1 },
        limit: 10,
      }),
      // Recent payments so admin can reconcile the active plan against what was
      // actually paid for (the "paid Pro but shows Regular" check).
      paymentRepository.find({ workspace: workspaceId }, undefined, {
        sort: { createdAt: -1 },
        limit: 10,
        populate: { path: 'plan', select: 'name code priceAmount currency' },
      }),
    ]);

    return {
      user,
      workspace,
      subscription,
      usage: {
        connectedAccounts,
        automations,
        studioAutomations,
        leads,
        messagesLast30Days,
      },
      recentActivity,
      payments,
      // toJSON strips adminNotes off `user`; surfaced separately, admin-only.
      adminNotes: user.adminNotes ?? '',
    };
  }

  async setUserSuspended(actor: AuthUser, id: string, suspended: boolean): Promise<IUser> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    if (user._id.toString() === actor.id) {
      throw new BadRequestError('You cannot suspend your own account');
    }
    if (user.isSuperAdmin && suspended) {
      throw new ForbiddenError('Super admin accounts cannot be suspended');
    }

    const updated = await userRepository.updateById(user._id, {
      $set: { isSuspended: suspended, ...(suspended ? { suspendedAt: new Date() } : {}) },
      ...(suspended ? {} : { $unset: { suspendedAt: '' } }),
      // Invalidate refresh tokens issued before the suspension.
      ...(suspended ? { $inc: { tokenVersion: 1 } } : {}),
    });
    if (!updated) throw new NotFoundError('User not found');

    await activityService.log({
      workspace: user.workspace.toString(),
      user: actor.id,
      action: suspended
        ? ActivityAction.ADMIN_USER_SUSPENDED
        : ActivityAction.ADMIN_USER_UNSUSPENDED,
      description: `${actor.email} ${suspended ? 'suspended' : 'unsuspended'} ${user.email}`,
      entityType: 'User',
      entityId: user._id,
    });
    return updated;
  }

  /** Support tool: mark a user's email verified without the OTP flow. */
  async verifyUserEmail(actor: AuthUser, id: string): Promise<IUser> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    if (user.isEmailVerified) return user;

    const updated = await userRepository.updateById(user._id, {
      $set: { isEmailVerified: true },
      $unset: { emailOtpHash: '', emailOtpExpiresAt: '', emailOtpSentAt: '' },
    });
    if (!updated) throw new NotFoundError('User not found');

    await activityService.log({
      workspace: user.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_USER_VERIFIED,
      description: `${actor.email} manually verified ${user.email}`,
      entityType: 'User',
      entityId: user._id,
    });
    return updated;
  }

  /**
   * Hard-delete a user and their workspace's data (same cascade as the
   * self-serve "delete account" flow, minus the password check).
   */
  async deleteUser(actor: AuthUser, id: string): Promise<void> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    if (user._id.toString() === actor.id) {
      throw new BadRequestError('You cannot delete your own account from the admin panel');
    }
    if (user.isSuperAdmin) {
      throw new ForbiddenError('Super admin accounts cannot be deleted');
    }

    const workspaceId = user.workspace;
    await Promise.all([
      automationRepository.deleteMany({ workspace: workspaceId }),
      keywordRepository.deleteMany({ workspace: workspaceId }),
      messageRepository.deleteMany({ workspace: workspaceId }),
      conversationRepository.deleteMany({ workspace: workspaceId }),
      leadRepository.deleteMany({ workspace: workspaceId }),
      socialAccountRepository.deleteMany({ workspace: workspaceId }),
      notificationRepository.deleteMany({ workspace: workspaceId }),
      subscriptionRepository.deleteMany({ workspace: workspaceId }),
      studioAutomationRepository.deleteMany({ workspace: workspaceId }),
      linkTrackingService.deleteByWorkspace(workspaceId.toString()),
    ]);
    await userRepository.deleteMany({ workspace: workspaceId });
    await workspaceRepository.deleteById(workspaceId);
  }

  // ---- Subscriptions ---------------------------------------------------------

  listSubscriptions(filters: AdminSubscriptionFilters): Promise<PaginatedResult<ISubscription>> {
    const query: FilterQuery<ISubscription> = {};
    if (filters.status) query.status = filters.status;
    return subscriptionRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
      { path: 'plan', select: 'code name priceAmount currency interval' },
    ]);
  }

  /**
   * Churn radar + renewal forecast + dunning, in one call. Everything here is
   * actionable: pending cancellations can be saved before they end, upcoming
   * renewals are next week's revenue, and past-due rows are failing charges.
   */
  async getBillingInsights(): Promise<AdminBillingInsights> {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * DAY_MS);
    const populate = [
      { path: 'workspace' as const, select: 'name' },
      { path: 'plan' as const, select: 'name priceAmount currency' },
    ];

    const toRow = (s: ISubscription): LifecycleRow => {
      const ws = s.workspace as unknown as { name?: string };
      const plan = s.plan as unknown as { name?: string; priceAmount?: number; currency?: string };
      return {
        id: s._id.toString(),
        workspaceName: ws?.name ?? 'Unknown workspace',
        planName: plan?.name ?? 'Unknown plan',
        priceAmount: plan?.priceAmount ?? 0,
        currency: plan?.currency ?? 'INR',
        currentPeriodEnd: s.currentPeriodEnd,
        canceledAt: s.canceledAt,
        autoRenew: Boolean(s.externalSubscriptionId) && !s.cancelAtPeriodEnd,
        status: s.status,
      };
    };

    const [cancellations, renewals, pastDue] = await Promise.all([
      subscriptionRepository.find(
        {
          cancelAtPeriodEnd: true,
          status: { $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
          currentPeriodEnd: { $gte: now },
        },
        undefined,
        { sort: { currentPeriodEnd: 1 }, limit: 50, populate }
      ),
      subscriptionRepository.find(
        {
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: { $ne: true },
          currentPeriodEnd: { $gte: now, $lte: week },
        },
        undefined,
        { sort: { currentPeriodEnd: 1 }, limit: 50, populate }
      ),
      subscriptionRepository.find({ status: SubscriptionStatus.PAST_DUE }, undefined, {
        sort: { currentPeriodEnd: 1 },
        limit: 50,
        populate,
      }),
    ]);

    return {
      pendingCancellations: cancellations.map(toRow),
      // Only PAID periods count as revenue events; free plans never lapse.
      upcomingRenewals: renewals.map(toRow).filter((r) => r.priceAmount > 0),
      pastDue: pastDue.map(toRow),
    };
  }

  async updateSubscription(
    actor: AuthUser,
    id: string,
    params: UpdateSubscriptionParams
  ): Promise<ISubscription> {
    const subscription = await subscriptionRepository.findById(id);
    if (!subscription) throw new NotFoundError('Subscription not found');

    const set: Record<string, unknown> = {};
    const changes: string[] = [];

    if (params.planId) {
      const plan = await planRepository.findById(params.planId);
      if (!plan) throw new NotFoundError('Plan not found');
      set.plan = plan._id;
      // Changing the plan starts a fresh period of the new plan's length
      // (₹0 plans never lapse). extendDays below stacks on top if given.
      set.currentPeriodStart = new Date();
      set.currentPeriodEnd = plan.priceAmount > 0 ? planPeriodEnd(plan) : addDays(new Date(), 3650);
      changes.push(`plan → ${plan.code} (new period)`);
    }
    if (params.status) {
      set.status = params.status;
      if (params.status === SubscriptionStatus.CANCELED) {
        set.canceledAt = new Date();
      }
      changes.push(`status → ${params.status}`);
    }
    if (params.extendDays) {
      const base = (set.currentPeriodEnd as Date) ?? subscription.currentPeriodEnd;
      set.currentPeriodEnd = addDays(base, params.extendDays);
      if (subscription.trialEndsAt && subscription.status === SubscriptionStatus.TRIALING) {
        set.trialEndsAt = addDays(subscription.trialEndsAt, params.extendDays);
      }
      changes.push(`extended ${params.extendDays} day(s)`);
    }
    if (changes.length === 0) {
      throw new BadRequestError('There are no changes to save.');
    }

    const updated = await subscriptionRepository.updateById(subscription._id, { $set: set });
    if (!updated) throw new NotFoundError('Subscription not found');
    await updated.populate([
      { path: 'workspace', select: 'name' },
      { path: 'plan', select: 'code name priceAmount currency interval' },
    ]);

    await activityService.log({
      workspace: subscription.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_SUBSCRIPTION_UPDATED,
      description: `${actor.email} updated subscription: ${changes.join(', ')}`,
      entityType: 'Subscription',
      entityId: subscription._id,
    });
    return updated;
  }

  /**
   * Grant (or update) bonus benefits on top of the workspace's current plan —
   * extra replies/automations/account slots for the ongoing period only.
   * All-zero amounts remove the bonus. Every grant/removal is audit-logged
   * with a timestamp, and the grant record survives even after the bonus
   * itself is auto-removed when the plan ends.
   */
  async grantBonus(
    actor: AuthUser,
    subscriptionId: string,
    params: {
      monthlyMessages?: number;
      automations?: number;
      connectedAccounts?: number;
      note?: string;
    }
  ): Promise<ISubscription> {
    const subscription = await subscriptionRepository.findById(subscriptionId);
    if (!subscription) throw new NotFoundError('Subscription not found');

    const amounts = {
      monthlyMessages: Math.max(0, params.monthlyMessages ?? 0),
      automations: Math.max(0, params.automations ?? 0),
      connectedAccounts: Math.max(0, params.connectedAccounts ?? 0),
    };
    const isRemoval =
      amounts.monthlyMessages === 0 && amounts.automations === 0 && amounts.connectedAccounts === 0;

    const updated = await subscriptionRepository.updateById(
      subscription._id,
      isRemoval
        ? { $unset: { bonus: '' } }
        : {
            $set: {
              bonus: {
                ...amounts,
                grantedAt: new Date(),
                grantedBy: new Types.ObjectId(actor.id),
                note: params.note?.trim() || undefined,
              },
            },
          }
    );
    if (!updated) throw new NotFoundError('Subscription not found');
    await updated.populate([
      { path: 'workspace', select: 'name' },
      { path: 'plan', select: 'code name priceAmount currency interval durationDays' },
    ]);

    const parts = [
      amounts.monthlyMessages > 0 ? `+${amounts.monthlyMessages} replies` : null,
      amounts.automations > 0 ? `+${amounts.automations} automations` : null,
      amounts.connectedAccounts > 0 ? `+${amounts.connectedAccounts} accounts` : null,
    ].filter(Boolean);

    await activityService.log({
      workspace: subscription.workspace.toString(),
      user: actor.id,
      action: isRemoval ? ActivityAction.ADMIN_BONUS_REMOVED : ActivityAction.ADMIN_BONUS_GRANTED,
      description: isRemoval
        ? `${actor.email} removed the bonus benefits`
        : `${actor.email} granted bonus benefits: ${parts.join(', ')}${params.note ? ` — "${params.note.trim()}"` : ''} (valid for the current plan period)`,
      entityType: 'Subscription',
      entityId: subscription._id,
      metadata: isRemoval ? undefined : amounts,
    });
    return updated;
  }

  // ---- Plans ----------------------------------------------------------------

  /** All plans, including inactive ones (the public endpoint hides those). */
  listPlans(): Promise<IPlan[]> {
    return planRepository.find({}, undefined, { sort: { sortOrder: 1 } });
  }

  async createPlan(actor: AuthUser, params: PlanParams): Promise<IPlan> {
    if (!params.code || !params.name || params.priceAmount === undefined) {
      throw new BadRequestError('Please fill in the code, name, and a valid price.');
    }
    const existing = await planRepository.findOne({ code: params.code.toLowerCase() });
    if (existing) throw new ConflictError(`A plan with code "${params.code}" already exists`);

    const plan = await planRepository.create(params as Partial<IPlan>);
    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_PLAN_CREATED,
      description: `${actor.email} created plan "${plan.code}"`,
      entityType: 'Plan',
      entityId: plan._id,
    });
    return plan;
  }

  async updatePlan(actor: AuthUser, id: string, params: PlanParams): Promise<IPlan> {
    const plan = await planRepository.findById(id);
    if (!plan) throw new NotFoundError('Plan not found');

    if (params.code && params.code.toLowerCase() !== plan.code) {
      const existing = await planRepository.findOne({ code: params.code.toLowerCase() });
      if (existing) throw new ConflictError(`A plan with code "${params.code}" already exists`);
    }

    // Merge nested limits/entitlements so a partial update doesn't wipe siblings.
    const { limits, entitlements, ...rest } = params;
    const set: Record<string, unknown> = { ...rest };
    if (limits) {
      for (const [key, value] of Object.entries(limits)) {
        if (value !== undefined) set[`limits.${key}`] = value;
      }
    }
    if (entitlements) {
      for (const [key, value] of Object.entries(entitlements)) {
        if (value !== undefined) set[`entitlements.${key}`] = value;
      }
    }

    const updated = await planRepository.updateById(plan._id, { $set: set });
    if (!updated) throw new NotFoundError('Plan not found');

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_PLAN_UPDATED,
      description: `${actor.email} updated plan "${updated.code}"`,
      entityType: 'Plan',
      entityId: updated._id,
    });
    return updated;
  }

  /**
   * Create this plan at Razorpay so it can be sold as an auto-renewing
   * subscription, and remember the returned id. Until this runs, the plan is
   * hidden from customers (nothing to charge against). Idempotent: a plan that
   * already has an id is returned untouched.
   */
  async syncPlanWithRazorpay(actor: AuthUser, id: string): Promise<IPlan> {
    const plan = await planRepository.findById(id);
    if (!plan) throw new NotFoundError('Plan not found');
    if (plan.priceAmount === 0) {
      throw new BadRequestError(
        'Free plans do not need to be synced — they are always available to customers.'
      );
    }
    if (plan.razorpayPlanId) return plan;
    if (!paymentService.isConfigured()) {
      throw new BadRequestError(
        'Razorpay keys are not configured on the server, so plans cannot be synced yet.'
      );
    }

    // Razorpay bills "every N days" as period=daily + interval=N.
    const cycle =
      plan.interval === BillingInterval.YEARLY
        ? { period: 'yearly' as const, interval: 1 }
        : plan.interval === BillingInterval.DAYS
          ? {
              period: 'daily' as const,
              interval: Math.max(1, Math.min(365, plan.durationDays ?? 30)),
            }
          : { period: 'monthly' as const, interval: 1 };

    let planId: string;
    try {
      ({ planId } = await paymentService.createPlan({
        period: cycle.period,
        interval: cycle.interval,
        name: plan.name,
        description: plan.description,
        amount: plan.priceAmount,
        currency: plan.currency || 'INR',
        notes: { app: env.APP_ID, planCode: plan.code },
      }));
    } catch (error) {
      // Rethrow as a 400 with Razorpay's reason: the admin can usually fix
      // this by editing the plan (e.g. a non-INR currency on an INR-only
      // account), and a generic 5xx toast would hide what to fix.
      if (error instanceof AppError && error.errorCode === 'RAZORPAY_ORDER_FAILED') {
        const reason = error.message.replace(/^Payment gateway error: /, '');
        throw new BadRequestError(
          `Razorpay didn't accept this plan: ${reason}. Edit the plan (check its currency and price), then sync again.`
        );
      }
      throw error;
    }

    const updated = await planRepository.updateById(plan._id, {
      $set: { razorpayPlanId: planId },
    });
    if (!updated) throw new NotFoundError('Plan not found');

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_PLAN_SYNCED,
      description: `${actor.email} synced plan "${plan.code}" with Razorpay (${planId})`,
      entityType: 'Plan',
      entityId: plan._id,
    });
    return updated;
  }

  /**
   * Permanently remove a plan. Refused while any subscription still points at
   * it — a dangling plan reference silently degrades paying customers to
   * fallback entitlements (the "paid Pro but got Regular features" bug). Hide
   * it with the Visible switch instead; that keeps existing subscribers working.
   */
  async deletePlan(actor: AuthUser, id: string): Promise<void> {
    const plan = await planRepository.findById(id);
    if (!plan) throw new NotFoundError('Plan not found');

    const subscribers = await subscriptionRepository.count({ plan: plan._id });
    if (subscribers > 0) {
      throw new ConflictError(
        `${subscribers} workspace${subscribers === 1 ? '' : 's'} still use this plan, so it can't be deleted. Turn off "Visible" to retire it — existing subscribers keep working, and nobody new can pick it.`
      );
    }

    await planRepository.deleteById(plan._id);
    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_PLAN_DELETED,
      description: `${actor.email} deleted plan "${plan.code}"`,
      entityType: 'Plan',
      entityId: plan._id,
    });
  }

  // ---- Coupons (one-time discount codes) --------------------------------------

  listCoupons(
    filters: PaginationOptions & { search?: string; active?: boolean }
  ): Promise<PaginatedResult<ICoupon>> {
    const query: FilterQuery<ICoupon> = {};
    if (filters.search) query.code = containsRegex(filters.search);
    if (typeof filters.active === 'boolean') query.isActive = filters.active;
    return couponRepository.paginate(query, filters, undefined, [
      { path: 'plans', select: 'name code' },
    ]);
  }

  async createCoupon(
    actor: AuthUser,
    input: {
      code: string;
      description?: string;
      type: CouponType;
      value: number;
      currency?: string;
      maxRedemptions?: number;
      plans?: string[];
      expiresAt?: string;
      isActive?: boolean;
    }
  ): Promise<ICoupon> {
    const code = input.code.trim().toUpperCase();
    if (await couponRepository.findByCode(code)) {
      throw new ConflictError(`The code ${code} is already in use. Pick a different one.`);
    }
    this.assertCouponValue(input.type, input.value);

    const coupon = await couponRepository.create({
      code,
      description: input.description,
      type: input.type,
      value: input.value,
      currency: input.type === CouponType.FLAT ? (input.currency ?? 'INR') : undefined,
      maxRedemptions: input.maxRedemptions,
      plans: (input.plans ?? []).map((p) => new Types.ObjectId(p)),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      isActive: input.isActive ?? true,
      createdBy: new Types.ObjectId(actor.id),
    });

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_COUPON_CREATED,
      description: `${actor.email} created coupon ${code}`,
      entityType: 'Coupon',
      entityId: coupon._id,
    });
    return coupon;
  }

  async updateCoupon(
    actor: AuthUser,
    id: string,
    input: {
      description?: string;
      type?: CouponType;
      value?: number;
      currency?: string;
      maxRedemptions?: number | null;
      plans?: string[];
      expiresAt?: string | null;
      isActive?: boolean;
    }
  ): Promise<ICoupon> {
    const coupon = await couponRepository.findById(id);
    if (!coupon) throw new NotFoundError('Coupon not found');

    const type = input.type ?? coupon.type;
    const value = input.value ?? coupon.value;
    if (input.type !== undefined || input.value !== undefined) this.assertCouponValue(type, value);
    if (input.maxRedemptions != null && input.maxRedemptions < coupon.redemptionCount) {
      throw new BadRequestError(
        `This coupon has already been used ${coupon.redemptionCount} time${coupon.redemptionCount === 1 ? '' : 's'}, so the limit can't be lower than that.`
      );
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (input.description !== undefined) $set.description = input.description;
    if (input.type !== undefined) $set.type = input.type;
    if (input.value !== undefined) $set.value = input.value;
    if (input.isActive !== undefined) $set.isActive = input.isActive;
    if (input.plans !== undefined) $set.plans = input.plans.map((p) => new Types.ObjectId(p));
    if (input.currency !== undefined) $set.currency = input.currency;
    if (type === CouponType.PERCENT) $unset.currency = '';
    // null clears the limit / expiry ("unlimited", "never expires").
    if (input.maxRedemptions === null) $unset.maxRedemptions = '';
    else if (input.maxRedemptions !== undefined) $set.maxRedemptions = input.maxRedemptions;
    if (input.expiresAt === null) $unset.expiresAt = '';
    else if (input.expiresAt !== undefined) $set.expiresAt = new Date(input.expiresAt);

    const updated = await couponRepository.updateById(coupon._id, {
      ...(Object.keys($set).length ? { $set } : {}),
      ...(Object.keys($unset).length ? { $unset } : {}),
    });
    if (!updated) throw new NotFoundError('Coupon not found');

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_COUPON_UPDATED,
      description: `${actor.email} updated coupon ${coupon.code}`,
      entityType: 'Coupon',
      entityId: coupon._id,
    });
    return updated;
  }

  /**
   * Delete a coupon. Refused once it has been redeemed — the redemption
   * records point at it and are the audit trail for money already discounted.
   * Switching it off stops new uses without breaking that history.
   */
  async deleteCoupon(actor: AuthUser, id: string): Promise<void> {
    const coupon = await couponRepository.findById(id);
    if (!coupon) throw new NotFoundError('Coupon not found');

    const redemptions = await couponRedemptionRepository.count({ coupon: coupon._id });
    if (redemptions > 0) {
      throw new ConflictError(
        `${coupon.code} has already been used ${redemptions} time${redemptions === 1 ? '' : 's'}, so it can't be deleted. Switch it off instead — nobody new can use it, and your records stay intact.`
      );
    }

    await couponRepository.deleteById(coupon._id);
    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_COUPON_DELETED,
      description: `${actor.email} deleted coupon ${coupon.code}`,
      entityType: 'Coupon',
      entityId: coupon._id,
    });
  }

  /** Who used a coupon, when, and how much it took off. */
  listCouponRedemptions(
    couponId: string,
    filters: PaginationOptions
  ): Promise<PaginatedResult<ICouponRedemption>> {
    return couponRedemptionRepository.paginate(
      { coupon: new Types.ObjectId(couponId) },
      filters,
      undefined,
      [
        { path: 'workspace', select: 'name' },
        { path: 'plan', select: 'name code' },
      ]
    );
  }

  private assertCouponValue(type: CouponType, value: number): void {
    if (type === CouponType.PERCENT && (value < 1 || value > 100)) {
      throw new BadRequestError('A percentage discount must be between 1 and 100.');
    }
    if (type === CouponType.FLAT && value < 1) {
      throw new BadRequestError('A fixed discount must be more than zero.');
    }
  }

  // ---- Automation oversight ---------------------------------------------------

  /**
   * One merged, paginated view over classic AND Studio automations via
   * $unionWith, so spammy setups are findable regardless of which builder
   * created them. `kind` distinguishes the two ('classic' | 'studio').
   */
  async listAutomations(filters: AdminAutomationFilters): Promise<{
    items: AdminAutomationRow[];
    meta: ReturnType<typeof buildPaginationMeta>;
  }> {
    const postUnionMatch: Record<string, unknown> = {};
    if (filters.status) postUnionMatch.status = filters.status;
    if (filters.kind) postUnionMatch.kind = filters.kind;
    if (filters.search) postUnionMatch.name = containsRegex(filters.search);

    const pipeline: PipelineStage[] = [
      { $set: { kind: 'classic' } },
      {
        $unionWith: {
          coll: StudioAutomationModel.collection.name,
          pipeline: [{ $set: { kind: 'studio' } }],
        },
      },
      ...(Object.keys(postUnionMatch).length ? [{ $match: postUnionMatch }] : []),
      {
        $lookup: {
          from: 'workspaces',
          localField: 'workspace',
          foreignField: '_id',
          as: 'workspaceDoc',
        },
      },
      {
        $lookup: {
          from: 'socialaccounts',
          localField: 'socialAccount',
          foreignField: '_id',
          as: 'accountDoc',
        },
      },
      {
        $project: {
          name: 1,
          status: 1,
          kind: 1,
          triggerCount: 1,
          lastTriggeredAt: 1,
          createdAt: 1,
          workspace: {
            $let: {
              vars: { w: { $arrayElemAt: ['$workspaceDoc', 0] } },
              in: { _id: '$$w._id', name: '$$w.name' },
            },
          },
          socialAccount: {
            $let: {
              vars: { a: { $arrayElemAt: ['$accountDoc', 0] } },
              in: {
                _id: '$$a._id',
                name: '$$a.name',
                username: '$$a.username',
                platform: '$$a.platform',
              },
            },
          },
        },
      },
      { $sort: { ...filters.sort, _id: 1 } },
      {
        $facet: {
          items: [{ $skip: filters.skip }, { $limit: filters.limit }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await automationRepository.aggregate<{
      items: AdminAutomationRow[];
      total: Array<{ count: number }>;
    }>(pipeline);

    const total = result?.total[0]?.count ?? 0;
    return { items: result?.items ?? [], meta: buildPaginationMeta(total, filters) };
  }

  /** Force-pause or resume any automation (classic or Studio) platform-wide. */
  async setAutomationStatus(
    actor: AuthUser,
    id: string,
    kind: 'classic' | 'studio',
    status: 'active' | 'paused'
  ): Promise<void> {
    const repo = kind === 'studio' ? studioAutomationRepository : automationRepository;
    const automation = await repo.findById(id);
    if (!automation) throw new NotFoundError('Automation not found');

    await repo.updateById(automation._id, { $set: { status } });

    await activityService.log({
      workspace: automation.workspace.toString(),
      user: actor.id,
      action:
        status === 'paused'
          ? ActivityAction.ADMIN_AUTOMATION_PAUSED
          : ActivityAction.ADMIN_AUTOMATION_RESUMED,
      description: `${actor.email} ${status === 'paused' ? 'force-paused' : 'resumed'} ${kind} automation "${automation.name}"`,
      entityType: kind === 'studio' ? 'StudioAutomation' : 'Automation',
      entityId: automation._id,
    });
  }

  // ---- Platform health ----------------------------------------------------------

  async getHealth(): Promise<AdminHealth> {
    const now = new Date();
    const soon = addDays(now, 7);
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

    const workspaceName = { path: 'workspace' as const, select: 'name' };
    const webhookIssueFilter: FilterQuery<ISocialAccount> = {
      isActive: true,
      $or: [{ isWebhookSubscribed: false }, { lastError: { $exists: true, $nin: [null, ''] } }],
    };
    const expiredFilter: FilterQuery<ISocialAccount> = {
      isActive: true,
      tokenExpiresAt: { $lt: now },
    };
    const expiringFilter: FilterQuery<ISocialAccount> = {
      isActive: true,
      tokenExpiresAt: { $gte: now, $lte: soon },
    };

    const [
      totalAccounts,
      webhookIssueCount,
      expiredCount,
      expiringCount,
      webhookIssues,
      expiredTokens,
      expiringTokens,
      sent24h,
      failed24h,
      failed7d,
      recentFailures,
    ] = await Promise.all([
      socialAccountRepository.count({ isActive: true }),
      socialAccountRepository.count(webhookIssueFilter),
      socialAccountRepository.count(expiredFilter),
      socialAccountRepository.count(expiringFilter),
      socialAccountRepository.find(webhookIssueFilter, undefined, {
        sort: { updatedAt: -1 },
        limit: 20,
        populate: workspaceName,
      }),
      socialAccountRepository.find(expiredFilter, undefined, {
        sort: { tokenExpiresAt: 1 },
        limit: 20,
        populate: workspaceName,
      }),
      socialAccountRepository.find(expiringFilter, undefined, {
        sort: { tokenExpiresAt: 1 },
        limit: 20,
        populate: workspaceName,
      }),
      messageRepository.count({
        direction: MessageDirection.OUTBOUND,
        createdAt: { $gte: dayAgo },
      }),
      messageRepository.count({
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.FAILED,
        createdAt: { $gte: dayAgo },
      }),
      messageRepository.count({
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.FAILED,
        createdAt: { $gte: weekAgo },
      }),
      messageRepository.find(
        { direction: MessageDirection.OUTBOUND, status: MessageStatus.FAILED },
        'platform type error text createdAt workspace socialAccount',
        {
          sort: { createdAt: -1 },
          limit: 10,
          populate: [workspaceName, { path: 'socialAccount', select: 'name platform' }],
        }
      ),
    ]);

    const jobRuns = await jobRunRepository.latestPerJob();

    return {
      accounts: {
        total: totalAccounts,
        webhookIssues: webhookIssueCount,
        expiredTokens: expiredCount,
        expiringTokens: expiringCount,
      },
      webhookIssues,
      expiredTokens,
      expiringTokens,
      messages: {
        sent24h,
        failed24h,
        failed7d,
        failureRate24h: sent24h > 0 ? Math.round((failed24h / sent24h) * 100) : 0,
      },
      recentFailures,
      jobs: jobRuns.map((r) => ({
        job: r.job,
        ok: r.ok,
        summary: r.summary,
        lastRunAt: r.createdAt,
        durationMs: r.durationMs,
      })),
    };
  }

  /** Re-attempt the Meta webhook subscription for any account, cross-workspace. */
  async retryAccountWebhook(actor: AuthUser, id: string): Promise<ISocialAccount> {
    const account = await socialAccountRepository.findWithToken(id);
    if (!account) throw new NotFoundError('Connected account not found');
    if (!account.pageId) {
      throw new BadRequestError(
        "This account has no linked Facebook Page, so notifications can't be set up. Reconnect it and try again."
      );
    }

    try {
      await metaClient.subscribePageWebhooks(account.pageId, account.accessToken);
      // A plain `lastError: undefined` is stripped by Mongoose and would leave
      // the stale error in place (and the account stuck in the health list).
      await socialAccountRepository.updateById(account._id, {
        $set: { isWebhookSubscribed: true },
        $unset: { lastError: '' },
      });
    } catch (error) {
      const detail = (error as { details?: unknown })?.details;
      const reason =
        typeof detail === 'object' && detail
          ? JSON.stringify(detail).slice(0, 280)
          : (error as Error).message;
      logger.warn('Admin webhook retry failed', { accountId: id, reason });
      // lastError shows on the user's account card too — keep it friendly; the
      // raw Meta reason stays in the log line above.
      await socialAccountRepository.updateById(account._id, {
        isWebhookSubscribed: false,
        lastError:
          'Instagram notifications aren\'t set up yet, so automations can\'t hear new comments or DMs. Use "Retry webhook" or reconnect this account.',
      });
    }

    await activityService.log({
      workspace: account.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_WEBHOOK_RETRIED,
      description: `${actor.email} retried the webhook subscription for "${account.name}"`,
      entityType: 'SocialAccount',
      entityId: account._id,
    });

    const refreshed = await socialAccountRepository.findById(account._id, undefined, {
      populate: { path: 'workspace', select: 'name' },
    });
    return refreshed ?? account;
  }

  // ---- Broadcast ----------------------------------------------------------------

  /**
   * Send an in-app announcement (bell notification) to a user segment.
   * Suspended users are always excluded. Returns the recipient count.
   */
  async broadcast(actor: AuthUser, params: BroadcastParams): Promise<{ recipients: number }> {
    const channel = params.channel ?? 'bell';
    const userFilter: FilterQuery<IUser> = { isSuspended: { $ne: true } };
    if (params.audience === 'verified') userFilter.isEmailVerified = true;

    if (params.planId) {
      const subs = await subscriptionRepository.find(
        {
          plan: new Types.ObjectId(params.planId),
          status: { $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        },
        'workspace'
      );
      userFilter.workspace = { $in: subs.map((s) => s.workspace) };
    }

    const users = await userRepository.find(userFilter, '_id workspace name email');
    if (users.length === 0) return { recipients: 0 };

    if (channel !== 'email') {
      const docs = users.map((u) => ({
        workspace: u.workspace,
        user: u._id,
        type: NotificationType.SYSTEM,
        title: params.title,
        body: params.body,
        link: params.link,
        metadata: { broadcast: true, sentBy: actor.email },
      }));

      // Chunked inserts keep single write batches bounded as the user base grows.
      const CHUNK = 500;
      for (let i = 0; i < docs.length; i += CHUNK) {
        await notificationRepository.insertMany(docs.slice(i, i + CHUNK));
      }
    }

    if (channel !== 'bell') {
      // Best-effort per recipient (brevoClient swallows non-critical failures);
      // small batches keep us inside Brevo's rate limits.
      const EMAIL_CHUNK = 20;
      for (let i = 0; i < users.length; i += EMAIL_CHUNK) {
        await Promise.all(
          users
            .slice(i, i + EMAIL_CHUNK)
            .map((u) =>
              emailService.sendAnnouncement(u.email, u.name, params.title, params.body, params.link)
            )
        );
      }
    }

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_BROADCAST_SENT,
      description: `${actor.email} broadcast "${params.title}" to ${users.length} user(s) via ${channel} [${params.audience}${params.planId ? ', plan-filtered' : ''}]`,
      metadata: {
        title: params.title,
        audience: params.audience,
        channel,
        recipients: users.length,
      },
    });

    return { recipients: users.length };
  }

  // ---- Support inbox ------------------------------------------------------------

  /** Paginated contact-form submissions, newest first, optional status filter. */
  listSupportMessages(
    filters: PaginationOptions & { status?: ContactMessageStatus }
  ): Promise<PaginatedResult<IContactMessage>> {
    const query: FilterQuery<IContactMessage> = {};
    if (filters.status) query.status = filters.status;
    return contactMessageRepository.paginate(query, filters);
  }

  /** Update a support message's status / internal note. */
  async updateSupportMessage(
    actor: AuthUser,
    id: string,
    params: { status?: ContactMessageStatus; adminNote?: string }
  ): Promise<IContactMessage> {
    const existing = await contactMessageRepository.findById(id);
    if (!existing) throw new NotFoundError('Support message not found');

    const set: Record<string, unknown> = { handledBy: actor.id };
    if (params.status) set.status = params.status;
    if (params.adminNote !== undefined) set.adminNote = params.adminNote;

    const updated = await contactMessageRepository.updateById(existing._id, { $set: set });
    if (!updated) throw new NotFoundError('Support message not found');

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_SUPPORT_UPDATED,
      description: `${actor.email} marked support message from ${existing.email} as ${updated.status}`,
      entityType: 'ContactMessage',
      entityId: existing._id,
    });
    return updated;
  }

  /**
   * Email a password-reset link to any user — the "I'm locked out" support
   * button. Reuses the normal forgot-password flow (same token TTL).
   */
  async sendPasswordReset(actor: AuthUser, userId: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    await authService.forgotPassword(user.email);

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_PASSWORD_RESET_SENT,
      description: `${actor.email} sent a password-reset email to ${user.email}`,
      entityType: 'User',
      entityId: user._id,
    });
  }

  // ---- Impersonation ------------------------------------------------------------

  /**
   * Issue a short-lived access token FOR the target user, marked imp:true.
   * No refresh token is issued, so the session ends when the token expires;
   * destructive self-service routes reject impersonated sessions.
   */
  async impersonate(actor: AuthUser, id: string): Promise<{ accessToken: string; user: IUser }> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    if (user._id.toString() === actor.id) {
      throw new BadRequestError('You are already yourself');
    }
    if (user.isSuperAdmin) {
      throw new ForbiddenError('Super admin accounts cannot be impersonated');
    }
    if (user.isSuspended) {
      throw new BadRequestError('Suspended users cannot be impersonated');
    }

    const accessToken = signAccessToken({
      sub: user._id.toString(),
      workspaceId: user.workspace.toString(),
      role: user.role,
      email: user.email,
      imp: true,
      actor: actor.id,
      tv: user.tokenVersion ?? 0,
    });

    await activityService.log({
      workspace: user.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_IMPERSONATION_STARTED,
      description: `${actor.email} started impersonating ${user.email}`,
      entityType: 'User',
      entityId: user._id,
    });

    return { accessToken, user };
  }

  // ---- GDPR export ---------------------------------------------------------------

  /**
   * Bundle everything stored about a user's workspace into one JSON document.
   * Secrets never leave: toJSON transforms strip password/OTP/TOTP/tokens.
   * Messages are capped (newest first) to keep the export practical.
   */
  async exportUserData(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    const workspaceId = user.workspace;
    const MESSAGE_CAP = 5000;

    const [
      workspace,
      members,
      socialAccounts,
      automations,
      studioAutomations,
      leads,
      conversations,
      messages,
      messageTotal,
      notifications,
      subscription,
      invoices,
      payments,
      activity,
    ] = await Promise.all([
      workspaceRepository.findById(workspaceId),
      userRepository.find({ workspace: workspaceId }),
      socialAccountRepository.find({ workspace: workspaceId }),
      automationRepository.find({ workspace: workspaceId }),
      studioAutomationRepository.find({ workspace: workspaceId }),
      leadRepository.find({ workspace: workspaceId }),
      conversationRepository.find({ workspace: workspaceId }),
      messageRepository.find({ workspace: workspaceId }, undefined, {
        sort: { createdAt: -1 },
        limit: MESSAGE_CAP,
      }),
      messageRepository.count({ workspace: workspaceId }),
      notificationRepository.find({ user: user._id }),
      subscriptionRepository.findOne({ workspace: workspaceId }, undefined, {
        populate: { path: 'plan' },
      }),
      invoiceRepository.find({ workspace: workspaceId }),
      paymentRepository.find({ workspace: workspaceId }),
      activityLogRepository.find({ workspace: workspaceId }, undefined, {
        sort: { createdAt: -1 },
        limit: 1000,
      }),
    ]);

    await activityService.log({
      workspace: workspaceId.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_DATA_EXPORTED,
      description: `${actor.email} exported all data for ${user.email} (GDPR)`,
      entityType: 'User',
      entityId: user._id,
    });

    return {
      exportedAt: new Date().toISOString(),
      exportedFor: user.email,
      note:
        messageTotal > MESSAGE_CAP
          ? `messages truncated to the newest ${MESSAGE_CAP} of ${messageTotal}`
          : undefined,
      user,
      workspace,
      members,
      socialAccounts,
      automations,
      studioAutomations,
      leads,
      conversations,
      messages,
      notifications,
      subscription,
      invoices,
      payments,
      activity,
    };
  }

  // ---- Payments / refunds ---------------------------------------------------------

  listPayments(
    filters: PaginationOptions & { status?: PaymentStatus; app?: string }
  ): Promise<PaginatedResult<IPayment>> {
    const query: FilterQuery<IPayment> = {};
    if (filters.status) query.status = filters.status;
    if (filters.app) query.app = filters.app;
    return paymentRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
      { path: 'invoice', select: 'number status' },
      { path: 'plan', select: 'name code priceAmount currency' },
    ]);
  }

  listInvoices(
    filters: PaginationOptions & { status?: string; search?: string }
  ): Promise<PaginatedResult<IInvoice>> {
    const query: FilterQuery<IInvoice> = {};
    if (filters.status) query.status = filters.status;
    if (filters.search) query.number = containsRegex(filters.search);
    return invoiceRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
    ]);
  }

  /**
   * Refund a payment. When it was collected through Razorpay (and the gateway
   * is configured), the money is actually sent back via the refund API before
   * we mark it refunded locally; gateway refusal aborts the whole operation.
   * Payments recorded without a gateway id stay bookkeeping-only.
   */
  async refundPayment(actor: AuthUser, id: string): Promise<IPayment> {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new NotFoundError('Payment not found');
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestError('Only succeeded payments can be refunded');
    }

    let providerRefundId: string | undefined;
    if (
      payment.provider === 'razorpay' &&
      payment.providerPaymentId &&
      paymentService.isConfigured()
    ) {
      const result = await paymentService.refundPayment(payment.providerPaymentId);
      providerRefundId = result.refundId;
    }

    const updated = await paymentRepository.updateById(payment._id, {
      $set: {
        status: PaymentStatus.REFUNDED,
        refundedAt: new Date(),
        refundedBy: new Types.ObjectId(actor.id),
        ...(providerRefundId ? { providerRefundId } : {}),
      },
    });
    if (!updated) throw new NotFoundError('Payment not found');
    await updated.populate([
      { path: 'workspace', select: 'name' },
      { path: 'invoice', select: 'number status' },
    ]);

    await activityService.log({
      workspace: payment.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_PAYMENT_REFUNDED,
      description: providerRefundId
        ? `${actor.email} refunded a ${(payment.amount / 100).toFixed(2)} ${payment.currency} payment via Razorpay (${providerRefundId})`
        : `${actor.email} marked a ${(payment.amount / 100).toFixed(2)} ${payment.currency} payment as refunded`,
      entityType: 'Payment',
      entityId: payment._id,
    });
    return updated;
  }

  // ---- Workspace search (feature-flag allowlist picker) -----------------------------

  async searchWorkspaces(search?: string): Promise<Array<{ _id: Types.ObjectId; name: string }>> {
    const query: FilterQuery<IWorkspace> = search ? { name: containsRegex(search) } : {};
    const workspaces = await workspaceRepository.find(query, 'name', {
      sort: { name: 1 },
      limit: 10,
    });
    return workspaces.map((w) => ({ _id: w._id, name: w.name }));
  }

  // ---- Admin 2FA (TOTP) --------------------------------------------------------------

  /** Generate + store a pending TOTP secret; returns the QR for enrollment. */
  async totpSetup(
    actor: AuthUser
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await userRepository.findById(actor.id);
    if (!user) throw new NotFoundError('User not found');
    if (user.isTotpEnabled) {
      throw new ConflictError('2FA is already enabled — disable it first to re-enroll');
    }

    const secret = generateTotpSecret();
    await userRepository.updateById(user._id, { $set: { totpSecret: secret } });
    const otpauthUrl = buildTotpUri(user.email, secret);
    const qrDataUrl = await totpQrDataUrl(otpauthUrl);
    return { secret, otpauthUrl, qrDataUrl };
  }

  /** Confirm the enrollment code and switch 2FA on for the acting admin. */
  async totpEnable(actor: AuthUser, code: string): Promise<void> {
    const user = await userRepository.findById(actor.id, '+totpSecret');
    if (!user?.totpSecret) {
      throw new BadRequestError('Run 2FA setup first');
    }
    if (!verifyTotpCode(code, user.totpSecret)) {
      throw new BadRequestError('Incorrect code — check your authenticator app');
    }

    await userRepository.updateById(user._id, { $set: { isTotpEnabled: true } });
    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_2FA_ENABLED,
      description: `${actor.email} enabled two-factor authentication`,
    });
  }

  /** Turn 2FA off. Requires a valid current code so a hijacked session can't drop it. */
  async totpDisable(actor: AuthUser, code: string): Promise<void> {
    const user = await userRepository.findById(actor.id, '+totpSecret');
    if (!user?.isTotpEnabled || !user.totpSecret) {
      throw new BadRequestError('2FA is not enabled');
    }
    if (!verifyTotpCode(code, user.totpSecret)) {
      throw new BadRequestError('Incorrect code — check your authenticator app');
    }

    await userRepository.updateById(user._id, {
      $set: { isTotpEnabled: false },
      $unset: { totpSecret: '' },
    });
    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_2FA_DISABLED,
      description: `${actor.email} disabled two-factor authentication`,
    });
  }

  // ---- Deep analytics ----------------------------------------------------------

  async getAnalytics(): Promise<AdminAnalytics> {
    const now = new Date();
    const days90 = new Date(now.getTime() - 90 * DAY_MS);
    const days30 = new Date(now.getTime() - 30 * DAY_MS);
    const byDay = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

    const [signupsDaily, messagesDaily, leadsDaily, planDist, topByMessages] = await Promise.all([
      userRepository.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: days90 } } },
        { $group: { _id: byDay, count: { $sum: 1 } } },
      ]),
      messageRepository.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: days90 } } },
        { $group: { _id: byDay, count: { $sum: 1 } } },
      ]),
      leadRepository.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: days90 } } },
        { $group: { _id: byDay, count: { $sum: 1 } } },
      ]),
      subscriptionRepository.aggregate<{
        _id: Types.ObjectId;
        count: number;
        plan: { code?: string; name?: string };
      }>([
        {
          $match: { status: { $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
        },
        { $group: { _id: '$plan', count: { $sum: 1 } } },
        { $lookup: { from: 'plans', localField: '_id', foreignField: '_id', as: 'planDoc' } },
        {
          $project: {
            count: 1,
            plan: {
              $let: {
                vars: { p: { $arrayElemAt: ['$planDoc', 0] } },
                in: { code: '$$p.code', name: '$$p.name' },
              },
            },
          },
        },
        { $sort: { count: -1 } },
      ]),
      messageRepository.aggregate<{
        _id: Types.ObjectId;
        messages30d: number;
        workspace: { name?: string };
      }>([
        { $match: { createdAt: { $gte: days30 } } },
        { $group: { _id: '$workspace', messages30d: { $sum: 1 } } },
        { $sort: { messages30d: -1 } },
        { $limit: 10 },
        {
          $lookup: { from: 'workspaces', localField: '_id', foreignField: '_id', as: 'wsDoc' },
        },
        {
          $project: {
            messages30d: 1,
            workspace: {
              $let: {
                vars: { w: { $arrayElemAt: ['$wsDoc', 0] } },
                in: { name: '$$w.name' },
              },
            },
          },
        },
      ]),
    ]);

    const signupsMap = new Map(signupsDaily.map((d) => [d._id, d.count]));
    const messagesMap = new Map(messagesDaily.map((d) => [d._id, d.count]));
    const leadsMap = new Map(leadsDaily.map((d) => [d._id, d.count]));
    const daily: AdminAnalytics['daily'] = [];
    for (let i = 89; i >= 0; i--) {
      const key = dayKey(new Date(now.getTime() - i * DAY_MS));
      daily.push({
        date: key,
        signups: signupsMap.get(key) ?? 0,
        messages: messagesMap.get(key) ?? 0,
        leads: leadsMap.get(key) ?? 0,
      });
    }

    // Lead totals for the top workspaces (one query for all ten).
    const topIds = topByMessages.map((t) => t._id);
    const leadCounts = await leadRepository.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { workspace: { $in: topIds } } },
      { $group: { _id: '$workspace', count: { $sum: 1 } } },
    ]);
    const leadCountMap = new Map(leadCounts.map((l) => [l._id.toString(), l.count]));

    // Activation funnel (lifetime): signups → verified → connected an account
    // → created an automation → captured a lead. Steps from "connected" on are
    // workspace-level (this product is effectively one workspace per user).
    const distinctWs = { $group: { _id: '$workspace' } };
    const [totalUsers, verifiedUsers, accountWs, classicWs, studioWs, leadWs] = await Promise.all([
      userRepository.count({}),
      userRepository.count({ isEmailVerified: true }),
      socialAccountRepository.aggregate<{ _id: Types.ObjectId }>([distinctWs]),
      automationRepository.aggregate<{ _id: Types.ObjectId }>([distinctWs]),
      studioAutomationRepository.aggregate<{ _id: Types.ObjectId }>([distinctWs]),
      leadRepository.aggregate<{ _id: Types.ObjectId }>([distinctWs]),
    ]);
    const automationWorkspaces = new Set([
      ...classicWs.map((w) => w._id.toString()),
      ...studioWs.map((w) => w._id.toString()),
    ]);
    const funnel: AdminAnalytics['funnel'] = [
      { step: 'Signed up', count: totalUsers },
      { step: 'Verified email', count: verifiedUsers },
      { step: 'Connected an account', count: accountWs.length },
      { step: 'Created an automation', count: automationWorkspaces.size },
      { step: 'Captured a lead', count: leadWs.length },
    ];

    // Revenue + subscriber movement, last 12 calendar months.
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const byMonth = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
    const [revenueAgg, startedAgg, cancelledAgg, currencyDoc] = await Promise.all([
      paymentRepository.aggregate<{ _id: string; amount: number; payments: number }>([
        {
          $match: {
            status: PaymentStatus.SUCCEEDED,
            app: env.APP_ID,
            createdAt: { $gte: twelveMonthsAgo },
          },
        },
        { $group: { _id: byMonth, amount: { $sum: '$amount' }, payments: { $sum: 1 } } },
      ]),
      // Paid activations = successful payments' distinct workspaces per month.
      paymentRepository.aggregate<{ _id: string; started: number }>([
        {
          $match: {
            status: PaymentStatus.SUCCEEDED,
            app: env.APP_ID,
            createdAt: { $gte: twelveMonthsAgo },
          },
        },
        { $group: { _id: { m: byMonth, w: '$workspace' } } },
        { $group: { _id: '$_id.m', started: { $sum: 1 } } },
      ]),
      subscriptionRepository.aggregate<{ _id: string; cancelled: number }>([
        { $match: { canceledAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$canceledAt' } },
            cancelled: { $sum: 1 },
          },
        },
      ]),
      paymentRepository.findOne({ status: PaymentStatus.SUCCEEDED, app: env.APP_ID }),
    ]);

    const revenueMap = new Map(revenueAgg.map((r) => [r._id, r]));
    const startedMap = new Map(startedAgg.map((r) => [r._id, r.started]));
    const cancelledMap = new Map(cancelledAgg.map((r) => [r._id, r.cancelled]));
    const revenueMonthly: AdminAnalytics['revenueMonthly'] = [];
    const subscriberFlow: AdminAnalytics['subscriberFlow'] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const rev = revenueMap.get(key);
      revenueMonthly.push({ month: key, amount: rev?.amount ?? 0, payments: rev?.payments ?? 0 });
      subscriberFlow.push({
        month: key,
        started: startedMap.get(key) ?? 0,
        cancelled: cancelledMap.get(key) ?? 0,
      });
    }

    return {
      daily,
      planDistribution: planDist.map((p) => ({
        planId: p._id?.toString() ?? 'none',
        code: p.plan?.code ?? 'unknown',
        name: p.plan?.name ?? 'Unknown plan',
        count: p.count,
      })),
      topWorkspaces: topByMessages.map((t) => ({
        workspaceId: t._id.toString(),
        name: t.workspace?.name ?? 'Unknown workspace',
        messages30d: t.messages30d,
        leads: leadCountMap.get(t._id.toString()) ?? 0,
      })),
      funnel,
      revenueMonthly,
      subscriberFlow,
      currency: currencyDoc?.currency ?? 'INR',
    };
  }

  /** Audit-log CSV export (newest first, optional action filter, 20k cap). */
  async exportActivityCsv(action?: string): Promise<string> {
    const logs = await activityLogRepository.find(action ? { action } : {}, undefined, {
      sort: { createdAt: -1 },
      limit: 20000,
      populate: [
        { path: 'workspace', select: 'name' },
        { path: 'user', select: 'email' },
      ],
    });

    const columns: CsvColumn<IActivityLog>[] = [
      { header: 'Date', value: (l) => l.createdAt.toISOString() },
      { header: 'Action', value: (l) => l.action },
      { header: 'Description', value: (l) => l.description },
      {
        header: 'Workspace',
        value: (l) => (l.workspace as unknown as { name?: string })?.name ?? '',
      },
      { header: 'User', value: (l) => (l.user as unknown as { email?: string })?.email ?? '' },
      { header: 'Entity Type', value: (l) => l.entityType ?? '' },
      { header: 'Entity Id', value: (l) => (l.entityId ? String(l.entityId) : '') },
    ];
    return toCsv(logs, columns);
  }

  // ---- Workspaces directory -------------------------------------------------------

  /** Drill-in for one workspace: members, accounts, plan and usage at a glance. */
  async getWorkspaceDetail(id: string): Promise<AdminWorkspaceDetail> {
    const workspace = await workspaceRepository.findById(id);
    if (!workspace) throw new NotFoundError('Workspace not found');

    const days30 = new Date(Date.now() - 30 * DAY_MS);
    const [members, accounts, subscription, automations, studioAutomations, leads, messages30d] =
      await Promise.all([
        userRepository.find({ workspace: workspace._id }, undefined, { sort: { createdAt: 1 } }),
        socialAccountRepository.find({ workspace: workspace._id }, undefined, {
          sort: { createdAt: 1 },
        }),
        subscriptionRepository.findByWorkspace(id),
        automationRepository.count({ workspace: workspace._id }),
        studioAutomationRepository.count({ workspace: workspace._id }),
        leadRepository.count({ workspace: workspace._id }),
        messageRepository.count({ workspace: workspace._id, createdAt: { $gte: days30 } }),
      ]);

    return {
      workspace,
      members,
      accounts,
      subscription,
      usage: { automations, studioAutomations, leads, messages30d },
    };
  }

  async listWorkspaces(
    filters: PaginationOptions & { search?: string }
  ): Promise<{ items: AdminWorkspaceRow[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    const pipeline: PipelineStage[] = [
      ...(filters.search ? [{ $match: { name: containsRegex(filters.search) } }] : []),
      { $sort: { ...filters.sort, _id: 1 as const } },
      {
        $facet: {
          items: [
            { $skip: filters.skip },
            { $limit: filters.limit },
            {
              $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: 'workspace',
                as: 'members',
              },
            },
            {
              $lookup: {
                from: 'socialaccounts',
                localField: '_id',
                foreignField: 'workspace',
                as: 'accounts',
              },
            },
            {
              $lookup: {
                from: 'subscriptions',
                localField: '_id',
                foreignField: 'workspace',
                as: 'subs',
              },
            },
            { $addFields: { sub: { $arrayElemAt: ['$subs', 0] } } },
            {
              $lookup: {
                from: 'plans',
                localField: 'sub.plan',
                foreignField: '_id',
                as: 'planDoc',
              },
            },
            {
              $lookup: { from: 'users', localField: 'owner', foreignField: '_id', as: 'ownerDoc' },
            },
            {
              $project: {
                name: 1,
                createdAt: 1,
                memberCount: { $size: '$members' },
                accountCount: {
                  $size: {
                    $filter: { input: '$accounts', as: 'a', cond: '$$a.isActive' },
                  },
                },
                subscriptionStatus: '$sub.status',
                plan: {
                  $let: {
                    vars: { p: { $arrayElemAt: ['$planDoc', 0] } },
                    in: { code: '$$p.code', name: '$$p.name' },
                  },
                },
                owner: {
                  $let: {
                    vars: { o: { $arrayElemAt: ['$ownerDoc', 0] } },
                    in: { _id: '$$o._id', name: '$$o.name', email: '$$o.email' },
                  },
                },
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await workspaceRepository.aggregate<{
      items: AdminWorkspaceRow[];
      total: Array<{ count: number }>;
    }>(pipeline);
    const total = result?.total[0]?.count ?? 0;
    return { items: result?.items ?? [], meta: buildPaginationMeta(total, filters) };
  }

  // ---- Admin notes -------------------------------------------------------------------

  async getUserNotes(id: string): Promise<string> {
    const user = await userRepository.findById(id, '+adminNotes');
    if (!user) throw new NotFoundError('User not found');
    return user.adminNotes ?? '';
  }

  async setUserNotes(actor: AuthUser, id: string, notes: string): Promise<void> {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    await userRepository.updateById(user._id, {
      $set: { adminNotes: notes.trim().slice(0, 5000) },
    });
    await activityService.log({
      workspace: user.workspace.toString(),
      user: actor.id,
      action: ActivityAction.ADMIN_NOTES_UPDATED,
      description: `${actor.email} updated internal notes for ${user.email}`,
      entityType: 'User',
      entityId: user._id,
    });
  }

  // ---- Users CSV export ----------------------------------------------------------------

  async exportUsersCsv(
    filters: {
      search?: string;
      verified?: boolean;
      suspended?: boolean;
    } = {}
  ): Promise<string> {
    // Honors the same filters as the users list, so "export what I'm looking at"
    // exports exactly that segment.
    const users = await userRepository.find(this.buildUserFilter(filters), undefined, {
      sort: { createdAt: -1 },
      limit: 20000,
      populate: { path: 'workspace', select: 'name' },
    });

    const columns: CsvColumn<IUser>[] = [
      { header: 'Name', value: (u) => u.name },
      { header: 'Email', value: (u) => u.email },
      {
        header: 'Workspace',
        value: (u) => (u.workspace as unknown as { name?: string })?.name ?? '',
      },
      { header: 'Verified', value: (u) => (u.isEmailVerified ? 'yes' : 'no') },
      { header: 'Suspended', value: (u) => (u.isSuspended ? 'yes' : 'no') },
      { header: 'Super Admin', value: (u) => (u.isSuperAdmin ? 'yes' : 'no') },
      { header: 'Last Login', value: (u) => (u.lastLoginAt ? toDateKey(u.lastLoginAt) : '') },
      { header: 'Signed Up', value: (u) => toDateKey(u.createdAt) },
    ];
    return toCsv(users, columns);
  }

  // ---- Maintenance banner -----------------------------------------------------------------

  async getBanner(): Promise<ISystemBanner> {
    const setting = await SystemSettingModel.findOne({ key: 'global' }).exec();
    return setting?.banner ?? { enabled: false, message: '', level: 'info' };
  }

  async setBanner(actor: AuthUser, banner: ISystemBanner): Promise<ISystemBanner> {
    const updated = await SystemSettingModel.findOneAndUpdate(
      { key: 'global' },
      { $set: { banner } },
      { new: true, upsert: true }
    ).exec();

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_BANNER_UPDATED,
      description: banner.enabled
        ? `${actor.email} enabled the ${banner.level} banner: "${banner.message.slice(0, 80)}"`
        : `${actor.email} disabled the site banner`,
    });
    return updated.banner;
  }

  // ---- Activity --------------------------------------------------------------

  /** Cross-workspace activity feed (platform-wide audit trail). */
  listActivity(
    filters: PaginationOptions & { action?: string; workspaceId?: string }
  ): Promise<PaginatedResult<IActivityLog>> {
    const query: FilterQuery<IActivityLog> = {};
    if (filters.action) query.action = filters.action;
    if (filters.workspaceId) query.workspace = new Types.ObjectId(filters.workspaceId);
    return activityLogRepository.paginate(query, filters, undefined, [
      { path: 'user', select: 'name email' },
      { path: 'workspace', select: 'name' },
    ]);
  }
}

export const adminService = new AdminService();
