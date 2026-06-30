import { FilterQuery } from 'mongoose';
import {
  ActivityAction,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  Platform,
} from '../constants';
import { IConversation } from '../models/conversation.model';
import { IMessage } from '../models/message.model';
import {
  conversationRepository,
  messageRepository,
  socialAccountRepository,
} from '../repositories';
import { AuthUser } from '../types/auth.types';
import { PaginatedResult, PaginationOptions } from '../types/common.types';
import { BadRequestError, NotFoundError } from '../utils/AppError';
import { activityService } from './activity.service';
import { metaClient } from './meta';

interface ConversationFilters extends PaginationOptions {
  platform?: Platform;
  status?: ConversationStatus;
  socialAccountId?: string;
  search?: string;
}

class InboxService {
  list(workspaceId: string, filters: ConversationFilters): Promise<PaginatedResult<IConversation>> {
    const query: FilterQuery<IConversation> = { workspace: workspaceId };
    if (filters.platform) query.platform = filters.platform;
    if (filters.status) query.status = filters.status;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.search) {
      query.$or = [
        { participantUsername: { $regex: filters.search, $options: 'i' } },
        { participantName: { $regex: filters.search, $options: 'i' } },
      ];
    }
    // Always sort the inbox by most-recent activity.
    return conversationRepository.paginate(
      query,
      { ...filters, sort: { lastMessageAt: -1 } },
      undefined,
      { path: 'socialAccount', select: 'name platform username' }
    );
  }

  async getConversation(workspaceId: string, id: string): Promise<IConversation> {
    const convo = await conversationRepository.findOne({ _id: id, workspace: workspaceId });
    if (!convo) throw new NotFoundError('Conversation not found');
    return convo;
  }

  /** Fetch a conversation with its full message history and mark it read. */
  async getThread(
    workspaceId: string,
    id: string
  ): Promise<{ conversation: IConversation; messages: IMessage[] }> {
    const conversation = await this.getConversation(workspaceId, id);
    const messages = await messageRepository.listByConversation(conversation._id.toString());
    if (conversation.status === ConversationStatus.UNREAD) {
      await conversationRepository.markRead(conversation._id.toString());
      conversation.status = ConversationStatus.READ;
      conversation.unreadCount = 0;
    }
    return { conversation, messages };
  }

  async setStatus(
    workspaceId: string,
    id: string,
    status: ConversationStatus
  ): Promise<IConversation> {
    const convo = await this.getConversation(workspaceId, id);
    const updated = await conversationRepository.updateById(convo._id, {
      status,
      ...(status !== ConversationStatus.UNREAD ? { unreadCount: 0 } : {}),
    });
    return updated!;
  }

  /** Send a manual reply from an agent in a conversation. */
  async reply(user: AuthUser, conversationId: string, text: string): Promise<IMessage> {
    const conversation = await this.getConversation(user.workspaceId, conversationId);

    const account = await socialAccountRepository.findWithToken(
      conversation.socialAccount.toString()
    );
    if (!account || !account.isActive) {
      throw new BadRequestError('The connected account for this conversation is unavailable');
    }
    if (!account.pageId) {
      throw new BadRequestError('Account is missing a page id required to send messages');
    }

    // Record the outbound message as pending, then attempt delivery.
    const message = await messageRepository.create({
      workspace: conversation.workspace,
      socialAccount: account._id,
      conversation: conversation._id,
      platform: conversation.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: conversation.participantId,
      text,
      isAutomated: false,
    });

    try {
      const result = await metaClient.sendDirectMessage(
        account.pageId,
        conversation.participantId,
        text,
        account.accessToken
      );
      await messageRepository.updateById(message._id, {
        status: MessageStatus.SENT,
        externalId: result.message_id,
      });
      message.status = MessageStatus.SENT;
    } catch (error) {
      await messageRepository.updateById(message._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
      throw error;
    }

    await conversationRepository.updateById(conversation._id, {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 280),
      status: ConversationStatus.READ,
    });

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.MESSAGE_SENT,
      description: 'Sent a manual reply',
      entityType: 'Conversation',
      entityId: conversation._id,
    });

    return message;
  }

  /** Workspace-wide unread count for the inbox badge. */
  countUnread(workspaceId: string): Promise<number> {
    return conversationRepository.countUnreadByWorkspace(workspaceId);
  }
}

export const inboxService = new InboxService();
