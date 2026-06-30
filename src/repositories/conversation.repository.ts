import { ConversationModel, IConversation } from '../models/conversation.model';
import { ConversationStatus } from '../constants';
import { BaseRepository } from './base.repository';

class ConversationRepository extends BaseRepository<IConversation> {
  constructor() {
    super(ConversationModel);
  }

  findByParticipant(socialAccountId: string, participantId: string): Promise<IConversation | null> {
    return this.findOne({ socialAccount: socialAccountId, participantId });
  }

  /**
   * Upsert a conversation for an inbound message, bumping recency/unread.
   * Returns the up-to-date document.
   */
  async upsertForInbound(params: {
    workspace: string;
    socialAccount: string;
    platform: string;
    participantId: string;
    participantUsername?: string;
    participantName?: string;
    preview: string;
    at: Date;
  }): Promise<IConversation> {
    const doc = await this.model
      .findOneAndUpdate(
        { socialAccount: params.socialAccount, participantId: params.participantId },
        {
          $set: {
            workspace: params.workspace,
            platform: params.platform,
            participantUsername: params.participantUsername,
            participantName: params.participantName,
            lastMessageAt: params.at,
            lastMessagePreview: params.preview.slice(0, 280),
            status: ConversationStatus.UNREAD,
          },
          $inc: { unreadCount: 1 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      )
      .exec();
    return doc;
  }

  /** Mark a conversation read and reset its unread counter. */
  markRead(id: string): Promise<IConversation | null> {
    return this.updateById(id, {
      $set: { status: ConversationStatus.READ, unreadCount: 0 },
    });
  }

  countUnreadByWorkspace(workspaceId: string): Promise<number> {
    return this.count({ workspace: workspaceId, status: ConversationStatus.UNREAD });
  }
}

export const conversationRepository = new ConversationRepository();
