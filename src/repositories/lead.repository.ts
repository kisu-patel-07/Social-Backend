import { ILead, LeadModel } from '../models/lead.model';
import { BaseRepository } from './base.repository';

class LeadRepository extends BaseRepository<ILead> {
  constructor() {
    super(LeadModel);
  }

  findByExternalUser(socialAccountId: string, externalUserId: string): Promise<ILead | null> {
    return this.findOne({ socialAccount: socialAccountId, externalUserId });
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
