import { FilterQuery, PipelineStage, Types } from 'mongoose';
import {
  ActivityAction,
  AutomationStatus,
  BillingInterval,
  MessageDirection,
  MessageStatus,
  NotificationType,
  PaymentStatus,
  Platform,
  StudioAutomationStatus,
  SubscriptionStatus,
} from '../constants';
import { IActivityLog } from '../models/activityLog.model';
import { IMessage } from '../models/message.model';
import { IPayment } from '../models/payment.model';
import { IPlan } from '../models/plan.model';
import { ISocialAccount } from '../models/socialAccount.model';
import { ISubscription } from '../models/subscription.model';
import { IUser } from '../models/user.model';
import { IWorkspace } from '../models/workspace.model';
import { StudioAutomationModel } from '../models/studioAutomation.model';
import { ISystemBanner, SystemSettingModel } from '../models/systemSetting.model';
import { metaClient } from './meta';
import { logger } from '../config/logger';
import { planPeriodEnd } from './subscription.service';
import { signAccessToken } from '../utils/jwt';
import { buildTotpUri, generateTotpSecret, totpQrDataUrl, verifyTotpCode } from '../utils/totp';
import { CsvColumn, toCsv } from '../utils/csv';
import { toDateKey } from '../utils/date';
import { containsRegex } from '../utils/text';
import { linkTrackingService } from './linkTracking.service';
import {
  activityLogRepository,
  automationRepository,
  conversationRepository,
  invoiceRepository,
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
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/AppError';
import { addDays } from '../utils/date';
import { buildPaginationMeta } from '../utils/pagination';
import { activityService } from './activity.service';

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
}

interface BroadcastParams {
  title: string;
  body: string;
  link?: string;
  audience: 'all' | 'verified';
  /** Restrict to workspaces on this plan (active/trialing). */
  planId?: string;
}

/** Deep-dive metrics for the admin analytics page. */
export interface AdminAnalytics {
  /** 90-day daily series. */
  daily: Array<{ date: string; signups: number; messages: number; leads: number }>;
  planDistribution: Array<{ planId: string; code: string; name: string; count: number }>;
  topWorkspaces: Array<{ workspaceId: string; name: string; messages30d: number; leads: number }>;
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

  listUsers(filters: AdminUserFilters): Promise<PaginatedResult<IUser>> {
    const query: FilterQuery<IUser> = {};
    if (filters.verified !== undefined) query.isEmailVerified = filters.verified;
    if (filters.suspended !== undefined) query.isSuspended = filters.suspended;
    if (filters.search) {
      query.$or = [
        { name: containsRegex(filters.search) },
        { email: containsRegex(filters.search) },
      ];
    }
    return userRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
    ]);
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
      throw new BadRequestError('Nothing to update');
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
      throw new BadRequestError('code, name and priceAmount are required');
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
    };
  }

  /** Re-attempt the Meta webhook subscription for any account, cross-workspace. */
  async retryAccountWebhook(actor: AuthUser, id: string): Promise<ISocialAccount> {
    const account = await socialAccountRepository.findWithToken(id);
    if (!account) throw new NotFoundError('Connected account not found');
    if (!account.pageId) {
      throw new BadRequestError('This account has no linked Page to subscribe.');
    }

    try {
      await metaClient.subscribePageWebhooks(account.pageId, account.accessToken);
      await socialAccountRepository.updateById(account._id, {
        isWebhookSubscribed: true,
        lastError: undefined,
      });
    } catch (error) {
      const detail = (error as { details?: unknown })?.details;
      const reason =
        typeof detail === 'object' && detail
          ? JSON.stringify(detail).slice(0, 280)
          : (error as Error).message;
      logger.warn('Admin webhook retry failed', { accountId: id, reason });
      await socialAccountRepository.updateById(account._id, {
        isWebhookSubscribed: false,
        lastError: reason,
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

    const users = await userRepository.find(userFilter, '_id workspace');
    if (users.length === 0) return { recipients: 0 };

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

    await activityService.log({
      workspace: actor.workspaceId,
      user: actor.id,
      action: ActivityAction.ADMIN_BROADCAST_SENT,
      description: `${actor.email} broadcast "${params.title}" to ${users.length} user(s) [${params.audience}${params.planId ? ', plan-filtered' : ''}]`,
      metadata: { title: params.title, audience: params.audience, recipients: users.length },
    });

    return { recipients: users.length };
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
    filters: PaginationOptions & { status?: PaymentStatus }
  ): Promise<PaginatedResult<IPayment>> {
    const query: FilterQuery<IPayment> = {};
    if (filters.status) query.status = filters.status;
    return paymentRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
      { path: 'invoice', select: 'number status' },
    ]);
  }

  /**
   * Bookkeeping refund: marks the payment refunded and comps nothing else.
   * When a real gateway lands, its refund API call slots in right here.
   */
  async refundPayment(actor: AuthUser, id: string): Promise<IPayment> {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new NotFoundError('Payment not found');
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestError('Only succeeded payments can be refunded');
    }

    const updated = await paymentRepository.updateById(payment._id, {
      $set: {
        status: PaymentStatus.REFUNDED,
        refundedAt: new Date(),
        refundedBy: new Types.ObjectId(actor.id),
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
      description: `${actor.email} marked a ${(payment.amount / 100).toFixed(2)} ${payment.currency} payment as refunded`,
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
    };
  }

  // ---- Workspaces directory -------------------------------------------------------

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

  async exportUsersCsv(): Promise<string> {
    const users = await userRepository.find({}, undefined, {
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
