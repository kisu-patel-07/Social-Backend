import { FilterQuery } from 'mongoose';
import { ActivityAction, LeadStatus, Platform } from '../constants';
import { ILead } from '../models/lead.model';
import { leadRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { NotFoundError } from '../utils/AppError';
import { CsvColumn, toCsv } from '../utils/csv';
import { toDateKey } from '../utils/date';
import { activityService } from './activity.service';

interface LeadListFilters extends PaginationOptions {
  platform?: Platform;
  status?: LeadStatus;
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

class LeadService {
  private buildQuery(workspaceId: string, filters: Partial<LeadListFilters>): FilterQuery<ILead> {
    const query: FilterQuery<ILead> = { workspace: workspaceId };
    if (filters.platform) query.platform = filters.platform;
    if (filters.status) query.status = filters.status;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.tag) query.tags = filters.tag;
    if (filters.search) {
      query.$or = [
        { username: { $regex: filters.search, $options: 'i' } },
        { name: { $regex: filters.search, $options: 'i' } },
        { comment: { $regex: filters.search, $options: 'i' } },
      ];
    }
    return query;
  }

  list(workspaceId: string, filters: LeadListFilters): Promise<PaginatedResult<ILead>> {
    return leadRepository.paginate(this.buildQuery(workspaceId, filters), filters, undefined, {
      path: 'socialAccount',
      select: 'name platform username',
    });
  }

  async getById(workspaceId: string, id: string): Promise<ILead> {
    const lead = await leadRepository.findOne({ _id: id, workspace: workspaceId });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
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
      { header: 'Status', value: (l) => l.status },
      { header: 'Matched Keyword', value: (l) => l.matchedKeyword },
      { header: 'Comment', value: (l) => l.comment },
      { header: 'Post', value: (l) => l.postId },
      { header: 'Tags', value: (l) => l.tags.join('; ') },
      { header: 'Notes', value: (l) => l.notes },
      { header: 'Created Date', value: (l) => toDateKey(l.createdAt) },
    ];

    return toCsv(leads, columns);
  }
}

export const leadService = new LeadService();
