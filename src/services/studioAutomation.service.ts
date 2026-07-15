import { FilterQuery, Types } from 'mongoose';
import {
  ActivityAction,
  Platform,
  StudioAutomationStatus,
  StudioKeywordMode,
  StudioPostScope,
} from '../constants';
import { IStudioAutomation, IStudioButton } from '../models/studioAutomation.model';
import { socialAccountRepository } from '../repositories';
import { studioAutomationRepository } from '../repositories/studioAutomation.repository';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { BadRequestError, NotFoundError } from '../utils/AppError';
import { activityService } from './activity.service';

interface StudioAutomationParams {
  name: string;
  socialAccountId: string;
  platform: Platform;
  postScope: StudioPostScope;
  postIds: string[];
  keywordMode: StudioKeywordMode;
  keywords: string[];
  excludeKeywords: string[];
  publicReplyEnabled: boolean;
  publicReplies: string[];
  dmMessage: string;
  dmButtons: IStudioButton[];
  oncePerUser: boolean;
  templateKey?: string;
  status?: StudioAutomationStatus;
}

type UpdateStudioAutomationParams = Partial<
  Omit<StudioAutomationParams, 'socialAccountId' | 'platform' | 'templateKey'>
>;

interface ListFilters extends PaginationOptions {
  platform?: Platform;
  status?: StudioAutomationStatus;
  socialAccountId?: string;
  search?: string;
}

/** CRUD for Automation Studio (v2 trial). Matching lives in studioEngine.service. */
class StudioAutomationService {
  private normalizeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  }

  /**
   * A Studio automation may be saved as an incomplete draft, but going ACTIVE
   * requires a coherent trigger + response setup on the merged document.
   */
  private assertReadyToActivate(doc: {
    keywordMode: StudioKeywordMode;
    keywords: string[];
    postScope: StudioPostScope;
    postIds: string[];
    publicReplyEnabled: boolean;
    publicReplies: string[];
  }): void {
    if (doc.keywordMode !== StudioKeywordMode.ANY && !doc.keywords.length) {
      throw new BadRequestError(
        'Add at least one keyword (or set the trigger to "any comment") before going live'
      );
    }
    if (doc.postScope === StudioPostScope.SPECIFIC && !doc.postIds.length) {
      throw new BadRequestError('Pick at least one post (or target all posts) before going live');
    }
    if (doc.publicReplyEnabled && !doc.publicReplies.length) {
      throw new BadRequestError('Add a public reply (or disable public replies) before going live');
    }
  }

  async create(user: AuthUser, params: StudioAutomationParams): Promise<IStudioAutomation> {
    const account = await socialAccountRepository.findOne({
      _id: params.socialAccountId,
      workspace: user.workspaceId,
      isActive: true,
    });
    if (!account) throw new NotFoundError('Connected account not found');
    if (account.platform !== params.platform) {
      throw new BadRequestError('Platform does not match the selected account');
    }

    const candidate = {
      status: params.status ?? StudioAutomationStatus.DRAFT,
      postScope: params.postScope,
      postIds: params.postScope === StudioPostScope.SPECIFIC ? params.postIds : [],
      keywordMode: params.keywordMode,
      keywords: this.normalizeKeywords(params.keywords),
      excludeKeywords: this.normalizeKeywords(params.excludeKeywords),
      publicReplyEnabled: params.publicReplyEnabled,
      publicReplies: params.publicReplies,
    };
    if (candidate.status === StudioAutomationStatus.ACTIVE) {
      this.assertReadyToActivate(candidate);
    }

    const automation = await studioAutomationRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      socialAccount: account._id,
      platform: params.platform,
      name: params.name,
      ...candidate,
      dmMessage: params.dmMessage,
      dmButtons: params.dmButtons,
      oncePerUser: params.oncePerUser,
      templateKey: params.templateKey,
      createdBy: new Types.ObjectId(user.id),
    });

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.AUTOMATION_CREATED,
      description: `Created Studio automation "${automation.name}"`,
      entityType: 'StudioAutomation',
      entityId: automation._id,
    });

    return automation;
  }

  async list(
    workspaceId: string,
    filters: ListFilters
  ): Promise<PaginatedResult<IStudioAutomation>> {
    const query: FilterQuery<IStudioAutomation> = { workspace: workspaceId };
    if (filters.platform) query.platform = filters.platform;
    if (filters.status) query.status = filters.status;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.search) query.name = { $regex: filters.search, $options: 'i' };

    return studioAutomationRepository.paginate(query, filters, undefined, {
      path: 'socialAccount',
      select: 'name platform username avatarUrl',
    });
  }

  async getById(workspaceId: string, id: string): Promise<IStudioAutomation> {
    const automation = await studioAutomationRepository.findOne({
      _id: id,
      workspace: workspaceId,
    });
    if (!automation) throw new NotFoundError('Studio automation not found');
    return automation;
  }

  async update(
    user: AuthUser,
    id: string,
    params: UpdateStudioAutomationParams
  ): Promise<IStudioAutomation> {
    const existing = await this.getById(user.workspaceId, id);

    // Validate the merged state before persisting so a failed activation
    // never leaves a broken automation live.
    const merged = {
      status: params.status ?? existing.status,
      postScope: params.postScope ?? existing.postScope,
      postIds: params.postIds ?? existing.postIds,
      keywordMode: params.keywordMode ?? existing.keywordMode,
      keywords: params.keywords ? this.normalizeKeywords(params.keywords) : existing.keywords,
      excludeKeywords: params.excludeKeywords
        ? this.normalizeKeywords(params.excludeKeywords)
        : existing.excludeKeywords,
      publicReplyEnabled: params.publicReplyEnabled ?? existing.publicReplyEnabled,
      publicReplies: params.publicReplies ?? existing.publicReplies,
    };
    if (merged.status === StudioAutomationStatus.ACTIVE) {
      this.assertReadyToActivate(merged);
    }

    const updated = await studioAutomationRepository.updateById(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.postScope !== undefined ? { postScope: params.postScope } : {}),
      ...(params.postIds !== undefined ? { postIds: params.postIds } : {}),
      ...(params.keywordMode !== undefined ? { keywordMode: params.keywordMode } : {}),
      ...(params.keywords !== undefined
        ? { keywords: this.normalizeKeywords(params.keywords) }
        : {}),
      ...(params.excludeKeywords !== undefined
        ? { excludeKeywords: this.normalizeKeywords(params.excludeKeywords) }
        : {}),
      ...(params.publicReplyEnabled !== undefined
        ? { publicReplyEnabled: params.publicReplyEnabled }
        : {}),
      ...(params.publicReplies !== undefined ? { publicReplies: params.publicReplies } : {}),
      ...(params.dmMessage !== undefined ? { dmMessage: params.dmMessage } : {}),
      ...(params.dmButtons !== undefined ? { dmButtons: params.dmButtons } : {}),
      ...(params.oncePerUser !== undefined ? { oncePerUser: params.oncePerUser } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    });
    if (!updated) throw new NotFoundError('Studio automation not found');

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.AUTOMATION_UPDATED,
      description: `Updated Studio automation "${updated.name}"`,
      entityType: 'StudioAutomation',
      entityId: updated._id,
    });

    return updated;
  }

  async setStatus(
    user: AuthUser,
    id: string,
    status: StudioAutomationStatus
  ): Promise<IStudioAutomation> {
    return this.update(user, id, { status });
  }

  /** Clone an automation as a draft named "<name> (copy)". */
  async duplicate(user: AuthUser, id: string): Promise<IStudioAutomation> {
    const source = await this.getById(user.workspaceId, id);
    const copy = await studioAutomationRepository.create({
      workspace: source.workspace,
      socialAccount: source.socialAccount,
      platform: source.platform,
      name: `${source.name} (copy)`.slice(0, 120),
      status: StudioAutomationStatus.DRAFT,
      postScope: source.postScope,
      postIds: [...source.postIds],
      keywordMode: source.keywordMode,
      keywords: [...source.keywords],
      excludeKeywords: [...source.excludeKeywords],
      publicReplyEnabled: source.publicReplyEnabled,
      publicReplies: [...source.publicReplies],
      dmMessage: source.dmMessage,
      dmButtons: source.dmButtons.map((b) => ({ title: b.title, url: b.url })),
      oncePerUser: source.oncePerUser,
      templateKey: source.templateKey,
      createdBy: new Types.ObjectId(user.id),
    });

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.AUTOMATION_CREATED,
      description: `Duplicated Studio automation "${source.name}"`,
      entityType: 'StudioAutomation',
      entityId: copy._id,
    });

    return copy;
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const automation = await this.getById(user.workspaceId, id);
    await studioAutomationRepository.deleteById(automation._id);
    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.AUTOMATION_DELETED,
      description: `Deleted Studio automation "${automation.name}"`,
      entityType: 'StudioAutomation',
      entityId: automation._id,
    });
  }
}

export const studioAutomationService = new StudioAutomationService();
