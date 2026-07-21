import { FilterQuery, Types } from 'mongoose';
import {
  ActivityAction,
  AutomationStatus,
  AutomationTrigger,
  KeywordMatchType,
  Platform,
} from '../constants';
import { IAutomation } from '../models/automation.model';
import {
  automationRepository,
  keywordRepository,
  socialAccountRepository,
  studioAutomationRepository,
} from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';
import { assertWithinLimit, subscriptionService } from './subscription.service';

interface CreateAutomationParams {
  name: string;
  socialAccountId: string;
  platform: Platform;
  triggerType?: AutomationTrigger;
  targetPostId?: string;
  keywords: string[];
  matchType?: KeywordMatchType;
  publicReply?: string;
  privateMessage: string;
  status?: AutomationStatus;
}

interface UpdateAutomationParams {
  name?: string;
  triggerType?: AutomationTrigger;
  targetPostId?: string;
  keywords?: string[];
  matchType?: KeywordMatchType;
  publicReply?: string;
  privateMessage?: string;
  status?: AutomationStatus;
}

interface ListFilters extends PaginationOptions {
  platform?: Platform;
  status?: AutomationStatus;
  socialAccountId?: string;
  search?: string;
}

/** Triggers that may run with no keywords (fire on every matching event). */
const KEYWORD_OPTIONAL_TRIGGERS: AutomationTrigger[] = [
  AutomationTrigger.STORY,
  AutomationTrigger.STORY_MENTION,
];

class AutomationService {
  private normalizeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  }

  /**
   * Throw if any keyword is already used by another automation with the SAME
   * trigger type on this account. Different triggers listen to different
   * events (comments vs DMs vs story replies), so "price" can safely exist
   * once per trigger type.
   */
  private async assertNoDuplicateKeywords(
    socialAccountId: string,
    keywords: string[],
    triggerType: AutomationTrigger,
    excludeAutomationId?: string
  ): Promise<void> {
    if (keywords.length === 0) return;
    const conflicting = await automationRepository.find({
      socialAccount: socialAccountId,
      // Legacy docs predate triggerType and are comment automations.
      triggerType:
        triggerType === AutomationTrigger.COMMENT
          ? { $in: [AutomationTrigger.COMMENT, null] }
          : triggerType,
      keywords: { $in: keywords },
      ...(excludeAutomationId ? { _id: { $ne: excludeAutomationId } } : {}),
    });
    const dupes = [
      ...new Set(conflicting.flatMap((a) => a.keywords.filter((k) => keywords.includes(k)))),
    ];
    if (dupes.length) {
      throw new ConflictError(
        `These keywords are already used by another ${triggerType} automation on this account: ${dupes.join(', ')}`,
        { keywords: dupes }
      );
    }
  }

  /** Replace the Keyword documents for an automation. */
  private async syncKeywords(
    automation: IAutomation,
    keywords: string[],
    matchType: KeywordMatchType
  ): Promise<void> {
    await keywordRepository.deleteByAutomation(automation._id.toString());
    if (keywords.length) {
      await keywordRepository.insertMany(
        keywords.map((value) => ({
          workspace: automation.workspace,
          automation: automation._id,
          socialAccount: automation.socialAccount,
          value,
          matchType,
        }))
      );
    }
  }

  async create(user: AuthUser, params: CreateAutomationParams): Promise<IAutomation> {
    // Plan gate: classic + Studio automations share one plan limit.
    const { limits } = await subscriptionService.getEntitlements(user.workspaceId);
    const [classicCount, studioCount] = await Promise.all([
      automationRepository.count({ workspace: user.workspaceId }),
      studioAutomationRepository.count({ workspace: user.workspaceId }),
    ]);
    assertWithinLimit(classicCount + studioCount, limits.automations, 'automation(s)');

    const account = await socialAccountRepository.findOne({
      _id: params.socialAccountId,
      workspace: user.workspaceId,
      isActive: true,
    });
    if (!account) throw new NotFoundError('Connected account not found');
    if (account.platform !== params.platform) {
      throw new BadRequestError('Platform does not match the selected account');
    }

    const keywords = this.normalizeKeywords(params.keywords);
    // Story replies / mentions may run keyword-less (fire on every event).
    if (
      !keywords.length &&
      !KEYWORD_OPTIONAL_TRIGGERS.includes(params.triggerType ?? AutomationTrigger.COMMENT)
    ) {
      throw new BadRequestError('At least one keyword is required');
    }
    await this.assertNoDuplicateKeywords(
      params.socialAccountId,
      keywords,
      params.triggerType ?? AutomationTrigger.COMMENT
    );

    const matchType = params.matchType ?? KeywordMatchType.CONTAINS;
    const automation = await automationRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      socialAccount: account._id,
      platform: params.platform,
      name: params.name,
      targetPostId: params.targetPostId,
      keywords,
      triggerType: params.triggerType ?? AutomationTrigger.COMMENT,
      publicReply: params.publicReply,
      privateMessage: params.privateMessage,
      status: params.status ?? AutomationStatus.ACTIVE,
      createdBy: new Types.ObjectId(user.id),
    });

    // Keyword docs power the COMMENT pipeline only; DM/story automations skip
    // them (the collection has an account-wide unique index on keyword).
    if ((params.triggerType ?? AutomationTrigger.COMMENT) === AutomationTrigger.COMMENT) {
      await this.syncKeywords(automation, keywords, matchType);
    }
    await Promise.all([
      analyticsService.refreshWorkspaceStats(user.workspaceId),
      activityService.log({
        workspace: user.workspaceId,
        user: user.id,
        action: ActivityAction.AUTOMATION_CREATED,
        description: `Created automation "${automation.name}"`,
        entityType: 'Automation',
        entityId: automation._id,
      }),
    ]);

    return automation;
  }

  async list(workspaceId: string, filters: ListFilters): Promise<PaginatedResult<IAutomation>> {
    const query: FilterQuery<IAutomation> = { workspace: workspaceId };
    if (filters.platform) query.platform = filters.platform;
    if (filters.status) query.status = filters.status;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.search) query.name = { $regex: filters.search, $options: 'i' };

    return automationRepository.paginate(query, filters, undefined, {
      path: 'socialAccount',
      select: 'name platform username avatarUrl',
    });
  }

  async getById(workspaceId: string, id: string): Promise<IAutomation> {
    const automation = await automationRepository.findOne({ _id: id, workspace: workspaceId });
    if (!automation) throw new NotFoundError('Automation not found');
    return automation;
  }

  async update(user: AuthUser, id: string, params: UpdateAutomationParams): Promise<IAutomation> {
    const automation = await this.getById(user.workspaceId, id);
    // The trigger the automation will have after this update.
    const nextTrigger =
      params.triggerType ?? automation.triggerType ?? AutomationTrigger.COMMENT;

    let keywords: string[] | undefined;
    if (params.keywords) {
      keywords = this.normalizeKeywords(params.keywords);
      // Story replies / mentions may run keyword-less (fire on every event).
      if (!keywords.length && !KEYWORD_OPTIONAL_TRIGGERS.includes(nextTrigger)) {
        throw new BadRequestError('At least one keyword is required');
      }
      await this.assertNoDuplicateKeywords(
        automation.socialAccount.toString(),
        keywords,
        nextTrigger,
        automation._id.toString()
      );
    }

    const updated = await automationRepository.updateById(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.triggerType !== undefined ? { triggerType: params.triggerType } : {}),
      ...(params.targetPostId !== undefined ? { targetPostId: params.targetPostId } : {}),
      ...(params.publicReply !== undefined ? { publicReply: params.publicReply } : {}),
      ...(params.privateMessage !== undefined ? { privateMessage: params.privateMessage } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(keywords ? { keywords } : {}),
    });

    if (!updated) throw new NotFoundError('Automation not found');

    // Keyword docs power the comment pipeline only. Re-sync when comment
    // keywords change; drop them if this is (now) a DM/story/mention automation.
    if (nextTrigger === AutomationTrigger.COMMENT) {
      if (keywords) {
        await this.syncKeywords(updated, keywords, params.matchType ?? KeywordMatchType.CONTAINS);
      }
    } else {
      await keywordRepository.deleteMany({ automation: updated._id });
    }

    await Promise.all([
      analyticsService.refreshWorkspaceStats(user.workspaceId),
      activityService.log({
        workspace: user.workspaceId,
        user: user.id,
        action: ActivityAction.AUTOMATION_UPDATED,
        description: `Updated automation "${updated.name}"`,
        entityType: 'Automation',
        entityId: updated._id,
      }),
    ]);

    return updated;
  }

  async setStatus(user: AuthUser, id: string, status: AutomationStatus): Promise<IAutomation> {
    const updated = await this.update(user, id, { status });
    return updated;
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const automation = await this.getById(user.workspaceId, id);
    await keywordRepository.deleteByAutomation(automation._id.toString());
    await automationRepository.deleteById(automation._id);
    await Promise.all([
      analyticsService.refreshWorkspaceStats(user.workspaceId),
      activityService.log({
        workspace: user.workspaceId,
        user: user.id,
        action: ActivityAction.AUTOMATION_DELETED,
        description: `Deleted automation "${automation.name}"`,
        entityType: 'Automation',
        entityId: automation._id,
      }),
    ]);
  }
}

export const automationService = new AutomationService();
