import { FilterQuery, Types } from 'mongoose';
import {
  ActivityAction,
  DM_WINDOW_MS,
  LeadSource,
  LeadStatus,
  MessageDirection,
  MessageType,
  Platform,
} from '../constants';
import { ILead } from '../models/lead.model';
import { conversationRepository, leadRepository, messageRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { NotFoundError } from '../utils/AppError';
import { CsvColumn, toCsv } from '../utils/csv';
import { toDateKey } from '../utils/date';
import { containsRegex } from '../utils/text';
import { activityService } from './activity.service';

interface LeadListFilters extends PaginationOptions {
  platform?: Platform;
  status?: LeadStatus;
  source?: LeadSource;
  socialAccountId?: string;
  tag?: string;
  search?: string;
}

interface UpdateLeadParams {
  status?: LeadStatus;
  notes?: string;
  tags?: string[];
  name?: string;
}

interface BulkLeadParams {
  ids: string[];
  status?: LeadStatus;
  addTags?: string[];
}

/** Everything the contact detail modal needs in a single request. */
export interface LeadDetail {
  lead: ILead;
  conversation: {
    _id: string;
    avatarUrl?: string;
    username?: string;
    name?: string;
    status: string;
    lastMessageAt: Date;
    lastMessagePreview?: string;
    unreadCount: number;
  } | null;
  engagement: {
    dmsReceived: number;
    dmsSent: number;
    comments: number;
    lastInboundAt: Date | null;
    /** Whether a free-form DM can still be sent under Meta's 24h rule. */
    dmWindowOpen: boolean;
  };
}

export interface LeadStats {
  total: number;
  newThisWeek: number;
  activeLast24h: number;
  byStatus: Record<string, number>;
}

class LeadService {
  private buildQuery(workspaceId: string, filters: Partial<LeadListFilters>): FilterQuery<ILead> {
    const query: FilterQuery<ILead> = { workspace: workspaceId };
    if (filters.platform) query.platform = filters.platform;
    if (filters.status) query.status = filters.status;
    if (filters.source) query.source = filters.source;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.tag) query.tags = filters.tag;
    if (filters.search) {
      query.$or = [
        { username: containsRegex(filters.search) },
        { name: containsRegex(filters.search) },
        { comment: containsRegex(filters.search) },
      ];
    }
    return query;
  }

  list(workspaceId: string, filters: LeadListFilters): Promise<PaginatedResult<ILead>> {
    return leadRepository.paginate(this.buildQuery(workspaceId, filters), filters, undefined, [
      { path: 'socialAccount', select: 'name platform username' },
      // Avatar fallback for contacts created before avatars were cached on leads.
      { path: 'conversation', select: 'participantAvatarUrl' },
    ]);
  }

  async getById(workspaceId: string, id: string): Promise<ILead> {
    const lead = await leadRepository.findOne({ _id: id, workspace: workspaceId });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
  }

  /** Contact detail: the lead plus its conversation summary and engagement stats. */
  async getDetail(workspaceId: string, id: string): Promise<LeadDetail> {
    const lead = await leadRepository.findOne({ _id: id, workspace: workspaceId });
    if (!lead) throw new NotFoundError('Lead not found');

    const conversationId = lead.conversation?.toString();
    const [conversation, directionStats, commentCount] = await Promise.all([
      conversationId ? conversationRepository.findById(conversationId) : Promise.resolve(null),
      conversationId
        ? messageRepository.aggregate<{ _id: MessageDirection; count: number; lastAt: Date }>([
            {
              $match: {
                conversation: new Types.ObjectId(conversationId),
                type: MessageType.DIRECT_MESSAGE,
              },
            },
            { $group: { _id: '$direction', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
          ])
        : Promise.resolve([]),
      messageRepository.count({
        socialAccount: lead.socialAccount,
        type: MessageType.COMMENT,
        fromId: lead.externalUserId,
      }),
    ]);

    await lead.populate([
      { path: 'socialAccount', select: 'name platform username' },
      { path: 'automation', select: 'name' },
    ]);

    const inbound = directionStats.find((s) => s._id === MessageDirection.INBOUND);
    const outbound = directionStats.find((s) => s._id === MessageDirection.OUTBOUND);
    const lastInboundAt = inbound?.lastAt ?? null;

    return {
      lead,
      conversation: conversation
        ? {
            _id: conversation._id.toString(),
            avatarUrl: conversation.participantAvatarUrl,
            username: conversation.participantUsername,
            name: conversation.participantName,
            status: conversation.status,
            lastMessageAt: conversation.lastMessageAt,
            lastMessagePreview: conversation.lastMessagePreview,
            unreadCount: conversation.unreadCount,
          }
        : null,
      engagement: {
        dmsReceived: inbound?.count ?? 0,
        dmsSent: outbound?.count ?? 0,
        comments: commentCount,
        lastInboundAt,
        dmWindowOpen: Boolean(
          lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() < DM_WINDOW_MS
        ),
      },
    };
  }

  /** Headline numbers for the Contacts page. */
  async stats(workspaceId: string): Promise<LeadStats> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - DM_WINDOW_MS);

    const [total, newThisWeek, activeLast24h, byStatus] = await Promise.all([
      leadRepository.countByWorkspace(workspaceId),
      leadRepository.countCreatedBetween(workspaceId, weekAgo, now),
      leadRepository.count({ workspace: workspaceId, lastInteractionAt: { $gte: dayAgo } }),
      leadRepository.countByStatus(workspaceId),
    ]);

    return { total, newThisWeek, activeLast24h, byStatus };
  }

  /** Bulk status/tag change across selected leads. Returns modified count. */
  async bulkUpdate(user: AuthUser, params: BulkLeadParams): Promise<number> {
    const update: Record<string, unknown> = {};
    if (params.status) update.$set = { status: params.status };
    if (params.addTags?.length) update.$addToSet = { tags: { $each: params.addTags } };
    if (Object.keys(update).length === 0) return 0;

    const modified = await leadRepository.updateManyByIds(user.workspaceId, params.ids, update);
    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.LEAD_UPDATED,
      description: `Bulk-updated ${modified} lead(s)`,
      entityType: 'Lead',
    });
    return modified;
  }

  /** Bulk delete selected leads. Returns deleted count. */
  async bulkDelete(user: AuthUser, ids: string[]): Promise<number> {
    const deleted = await leadRepository.deleteMany({
      _id: { $in: ids },
      workspace: user.workspaceId,
    });
    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.LEAD_UPDATED,
      description: `Deleted ${deleted} lead(s)`,
      entityType: 'Lead',
    });
    return deleted;
  }

  async update(user: AuthUser, id: string, params: UpdateLeadParams): Promise<ILead> {
    const updated = await leadRepository.updateOne(
      { _id: id, workspace: user.workspaceId },
      {
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.notes !== undefined ? { notes: params.notes } : {}),
        ...(params.tags !== undefined ? { tags: params.tags } : {}),
        ...(params.name !== undefined ? { name: params.name } : {}),
      }
    );
    if (!updated) throw new NotFoundError('Lead not found');

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.LEAD_UPDATED,
      description: `Updated lead "${updated.username || updated.name || updated.externalUserId}"`,
      entityType: 'Lead',
      entityId: updated._id,
    });
    return updated;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const lead = await leadRepository.findOne({ _id: id, workspace: workspaceId });
    if (!lead) throw new NotFoundError('Lead not found');
    await leadRepository.deleteById(lead._id);
  }

  /** Generate a CSV export of leads matching the given filters. */
  async exportCsv(workspaceId: string, filters: Partial<LeadListFilters>): Promise<string> {
    const leads = await leadRepository.find(this.buildQuery(workspaceId, filters), undefined, {
      sort: { createdAt: -1 },
      limit: 10000, // export cap; logged so callers know it is bounded
    });

    const columns: CsvColumn<ILead>[] = [
      { header: 'Username', value: (l) => l.username },
      { header: 'Name', value: (l) => l.name },
      { header: 'Platform', value: (l) => l.platform },
      { header: 'Source', value: (l) => l.source },
      { header: 'Status', value: (l) => l.status },
      { header: 'Matched Keyword', value: (l) => l.matchedKeyword },
      { header: 'Comment', value: (l) => l.comment },
      { header: 'Post', value: (l) => l.postId },
      { header: 'Tags', value: (l) => l.tags.join('; ') },
      { header: 'Notes', value: (l) => l.notes },
      { header: 'Interactions', value: (l) => String(l.interactionCount ?? '') },
      { header: 'Last Interaction', value: (l) => toDateKey(l.lastInteractionAt) },
      { header: 'Created Date', value: (l) => toDateKey(l.createdAt) },
    ];

    return toCsv(leads, columns);
  }
}

export const leadService = new LeadService();
