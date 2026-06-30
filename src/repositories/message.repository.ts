import { IMessage, MessageModel } from '../models/message.model';
import { MessageType } from '../constants';
import { BaseRepository } from './base.repository';

class MessageRepository extends BaseRepository<IMessage> {
  constructor() {
    super(MessageModel);
  }

  /** Whether an external event was already recorded (idempotency guard). */
  existsByExternalId(socialAccountId: string, externalId: string): Promise<boolean> {
    return this.exists({ socialAccount: socialAccountId, externalId });
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
