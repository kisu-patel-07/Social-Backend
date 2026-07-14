import { FilterQuery, PipelineStage, Types } from 'mongoose';
import {
  ActivityAction,
  AutomationStatus,
  BillingInterval,
  MessageDirection,
  MessageStatus,
  NotificationType,
  Platform,
  StudioAutomationStatus,
  SubscriptionStatus,
} from '../constants';
import { IActivityLog } from '../models/activityLog.model';
import { IMessage } from '../models/message.model';
import { IPlan } from '../models/plan.model';
import { ISocialAccount } from '../models/socialAccount.model';
import { ISubscription } from '../models/subscription.model';
import { IUser } from '../models/user.model';
import { IWorkspace } from '../models/workspace.model';
import { StudioAutomationModel } from '../models/studioAutomation.model';
import { metaClient } from './meta';
import { logger } from '../config/logger';
import {
  activityLogRepository,
  automationRepository,
  conversationRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  notificationRepository,
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
  subscriptions: { byStatus: Record<string, number>; mrrCents: number };
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
  limits?: {
    connectedAccounts?: number;
    automations?: number;
    monthlyMessages?: number;
    teamMembers?: number;
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
      return (
        sum +
        (plan.interval === BillingInterval.YEARLY
          ? Math.round(plan.priceAmount / 12)
          : plan.priceAmount)
      );
    }, 0);

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
        { name: { $regex: filters.search, $options: 'i' } },
        { email: { $regex: filters.search, $options: 'i' } },
      ];
    }
    return userRepository.paginate(query, filters, undefined, [
      { path: 'workspace', select: 'name' },
    ]);
  }

  async getUserDetail(id: string): Promise<AdminUserDetail> {
    const user = await userRepository.findById(id);
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
      changes.push(`plan → ${plan.code}`);
    }
    if (params.status) {
      set.status = params.status;
      if (params.status === SubscriptionStatus.CANCELED) {
        set.canceledAt = new Date();
      }
      changes.push(`status → ${params.status}`);
    }
    if (params.extendDays) {
      set.currentPeriodEnd = addDays(subscription.currentPeriodEnd, params.extendDays);
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

    // Merge nested limits so a partial update doesn't wipe the other fields.
    const { limits, ...rest } = params;
    const set: Record<string, unknown> = { ...rest };
    if (limits) {
      for (const [key, value] of Object.entries(limits)) {
        if (value !== undefined) set[`limits.${key}`] = value;
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
    if (filters.search) postUnionMatch.name = { $regex: filters.search, $options: 'i' };

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
