import { FilterQuery, Types } from 'mongoose';
import { ActivityAction, AutomationStatus, KeywordMatchType, Platform } from '../constants';
import { IAutomation } from '../models/automation.model';
import { automationRepository, keywordRepository, socialAccountRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';

interface CreateAutomationParams {
  name: string;
  socialAccountId: string;
  platform: Platform;
  targetPostId?: string;
  keywords: string[];
  matchType?: KeywordMatchType;
  publicReply: string;
  privateMessage: string;
  status?: AutomationStatus;
}

interface UpdateAutomationParams {
  name?: string;
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

class AutomationService {
  private normalizeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  }

  /** Throw if any keyword is already used by another automation on the account. */
  private async assertNoDuplicateKeywords(
    socialAccountId: string,
    keywords: string[],
    excludeAutomationId?: string
  ): Promise<void> {
    const dupes = await keywordRepository.findDuplicates(
      socialAccountId,
      keywords,
      excludeAutomationId
    );
    if (dupes.length) {
      throw new ConflictError(
        `These keywords are already in use on this account: ${dupes.join(', ')}`,
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
    if (!keywords.length) throw new BadRequestError('At least one keyword is required');
    await this.assertNoDuplicateKeywords(params.socialAccountId, keywords);

    const matchType = params.matchType ?? KeywordMatchType.CONTAINS;
    const automation = await automationRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      socialAccount: account._id,
      platform: params.platform,
      name: params.name,
      targetPostId: params.targetPostId,
      keywords,
      publicReply: params.publicReply,
      privateMessage: params.privateMessage,
      status: params.status ?? AutomationStatus.ACTIVE,
      createdBy: new Types.ObjectId(user.id),
    });

    await this.syncKeywords(automation, keywords, matchType);
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

    let keywords: string[] | undefined;
    if (params.keywords) {
      keywords = this.normalizeKeywords(params.keywords);
      if (!keywords.length) throw new BadRequestError('At least one keyword is required');
      await this.assertNoDuplicateKeywords(
        automation.socialAccount.toString(),
        keywords,
        automation._id.toString()
      );
    }

    const updated = await automationRepository.updateById(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.targetPostId !== undefined ? { targetPostId: params.targetPostId } : {}),
      ...(params.publicReply !== undefined ? { publicReply: params.publicReply } : {}),
      ...(params.privateMessage !== undefined ? { privateMessage: params.privateMessage } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(keywords ? { keywords } : {}),
    });

    if (!updated) throw new NotFoundError('Automation not found');

    if (keywords) {
      await this.syncKeywords(updated, keywords, params.matchType ?? KeywordMatchType.CONTAINS);
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
