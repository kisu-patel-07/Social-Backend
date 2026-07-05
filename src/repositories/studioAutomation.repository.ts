import { FilterQuery } from 'mongoose';
import { IStudioAutomation, StudioAutomationModel } from '../models/studioAutomation.model';
import { StudioAutomationStatus, StudioPostScope } from '../constants';
import { BaseRepository } from './base.repository';

class StudioAutomationRepository extends BaseRepository<IStudioAutomation> {
  constructor() {
    super(StudioAutomationModel);
  }

  /**
   * Find active Studio automations that apply to a comment on the given post.
   * Sorted oldest-first so matching order is deterministic (first created wins).
   */
  findActiveMatching(socialAccountId: string, postId?: string): Promise<IStudioAutomation[]> {
    const filter: FilterQuery<IStudioAutomation> = {
      socialAccount: socialAccountId,
      status: StudioAutomationStatus.ACTIVE,
    };
    if (postId) {
      filter.$or = [{ postScope: StudioPostScope.ALL }, { postIds: postId }];
    } else {
      filter.postScope = StudioPostScope.ALL;
    }
    return this.find(filter, undefined, { sort: { createdAt: 1 } });
  }

  countActiveByWorkspace(workspaceId: string): Promise<number> {
    return this.count({ workspace: workspaceId, status: StudioAutomationStatus.ACTIVE });
  }

  /** Record a trigger: bump counters and stamp last-triggered time. */
  async registerTrigger(automationId: string, when: Date, dmSent: boolean): Promise<void> {
    await this.model
      .updateOne(
        { _id: automationId },
        {
          $inc: { triggerCount: 1, ...(dmSent ? { dmSentCount: 1 } : {}) },
          $set: { lastTriggeredAt: when },
        }
      )
      .exec();
  }
}

export const studioAutomationRepository = new StudioAutomationRepository();
