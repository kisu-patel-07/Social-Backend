import { IMessage, MessageModel } from '../models/message.model';
import { MessageStatus, MessageType } from '../constants';
import { BaseRepository } from './base.repository';

class MessageRepository extends BaseRepository<IMessage> {
  constructor() {
    super(MessageModel);
  }

  /** Whether an external event was already recorded (idempotency guard). */
  existsByExternalId(socialAccountId: string, externalId: string): Promise<boolean> {
    return this.exists({ socialAccount: socialAccountId, externalId });
  }

  /** Fetch a recorded inbound event by its external id (for reprocess checks). */
  findByExternalId(socialAccountId: string, externalId: string): Promise<IMessage | null> {
    return this.findOne({ socialAccount: socialAccountId, externalId });
  }

  /**
   * Claim an idempotent automated send. Reuses any existing record for this
   * dedupeKey (so a webhook retry doesn't create a second one) and reports
   * `alreadySent` when a prior attempt already delivered it. Handles the
   * concurrent-claim race on the unique dedupeKey by re-reading the winner.
   */
  async claimSend(
    dedupeKey: string,
    data: Partial<IMessage>
  ): Promise<{ message: IMessage; alreadySent: boolean }> {
    const existing = await this.findOne({ dedupeKey });
    if (existing) {
      return { message: existing, alreadySent: existing.status === MessageStatus.SENT };
    }
    try {
      const message = await this.create({ ...data, dedupeKey });
      return { message, alreadySent: false };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.findOne({ dedupeKey });
        if (winner) {
          return { message: winner, alreadySent: winner.status === MessageStatus.SENT };
        }
      }
      throw err;
    }
  }

  listByConversation(conversationId: string): Promise<IMessage[]> {
    return this.find({ conversation: conversationId }, undefined, { sort: { createdAt: 1 } });
  }

  /** Count messages of a type within a workspace and date range. */
  countByTypeBetween(
    workspaceId: string,
    type: MessageType,
    start: Date,
    end: Date
  ): Promise<number> {
    return this.count({
      workspace: workspaceId,
      type,
      createdAt: { $gte: start, $lte: end },
    });
  }
}

export const messageRepository = new MessageRepository();
