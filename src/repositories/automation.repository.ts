import { FilterQuery } from 'mongoose';
import { AutomationModel, IAutomation } from '../models/automation.model';
import { AutomationStatus } from '../constants';
import { BaseRepository } from './base.repository';

class AutomationRepository extends BaseRepository<IAutomation> {
  constructor() {
    super(AutomationModel);
  }

  /**
   * Find active automations for an account whose keyword list contains any of
   * the given normalized keywords. Used by the webhook processing pipeline.
   */
  findActiveMatching(socialAccountId: string, postId?: string): Promise<IAutomation[]> {
    const filter: FilterQuery<IAutomation> = {
      socialAccount: socialAccountId,
      status: AutomationStatus.ACTIVE,
    };
    // Either the automation targets all posts, or it targets this specific post.
    if (postId) {
      filter.$or = [{ targetPostId: { $in: [null, ''] } }, { targetPostId: postId }];
    }
    return this.find(filter);
  }

  countActiveByWorkspace(workspaceId: string): Promise<number> {
    return this.count({ workspace: workspaceId, status: AutomationStatus.ACTIVE });
  }

  /** Record a trigger: increment counters and stamp last-triggered time. */
  async registerTrigger(automationId: string, when: Date): Promise<void> {
    await this.model
      .updateOne(
        { _id: automationId },
        { $inc: { triggerCount: 1 }, $set: { lastTriggeredAt: when } }
      )
      .exec();
  }
}

export const automationRepository = new AutomationRepository();
