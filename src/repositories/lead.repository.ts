import { Types } from 'mongoose';
import { ILead, LeadModel } from '../models/lead.model';
import { BaseRepository } from './base.repository';

class LeadRepository extends BaseRepository<ILead> {
  constructor() {
    super(LeadModel);
  }

  findByExternalUser(socialAccountId: string, externalUserId: string): Promise<ILead | null> {
    return this.findOne({ socialAccount: socialAccountId, externalUserId });
  }

  /**
   * Record a repeat engagement on an existing lead: bump recency/counter and
   * backfill profile fields that were unknown when the lead was created.
   */
  registerInteraction(
    id: string,
    at: Date,
    profile?: { username?: string; name?: string; avatarUrl?: string }
  ): Promise<ILead | null> {
    return this.updateById(id, {
      $set: {
        lastInteractionAt: at,
        ...(profile?.username ? { username: profile.username } : {}),
        ...(profile?.name ? { name: profile.name } : {}),
        ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      },
      $inc: { interactionCount: 1 },
    });
  }

  /** Apply one update to many workspace leads at once. Returns modified count. */
  async updateManyByIds(
    workspaceId: string,
    ids: string[],
    update: Record<string, unknown>
  ): Promise<number> {
    const res = await this.model
      .updateMany({ _id: { $in: ids }, workspace: workspaceId }, update)
      .exec();
    return res.modifiedCount ?? 0;
  }

  /** Per-status lead counts for a workspace (missing statuses omitted). */
  async countByStatus(workspaceId: string): Promise<Record<string, number>> {
    const rows = await this.model
      .aggregate<{ _id: string; count: number }>([
        { $match: { workspace: new Types.ObjectId(workspaceId) } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  }

  /** Count leads created in a workspace within a date range. */
  countCreatedBetween(workspaceId: string, start: Date, end: Date): Promise<number> {
    return this.count({ workspace: workspaceId, createdAt: { $gte: start, $lte: end } });
  }

  countByWorkspace(workspaceId: string): Promise<number> {
    return this.count({ workspace: workspaceId });
  }
}

export const leadRepository = new LeadRepository();
