import { FilterQuery } from 'mongoose';
import {
  ActivityAction,
  ConversationStatus,
  DM_WINDOW_MS,
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

interface CommentFilters extends PaginationOptions {
  platform?: Platform;
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

  /** All incoming comments captured by webhooks, whether or not an automation matched. */
  listComments(workspaceId: string, filters: CommentFilters): Promise<PaginatedResult<IMessage>> {
    const query: FilterQuery<IMessage> = {
      workspace: workspaceId,
      type: MessageType.COMMENT,
      direction: MessageDirection.INBOUND,
    };
    if (filters.platform) query.platform = filters.platform;
    if (filters.socialAccountId) query.socialAccount = filters.socialAccountId;
    if (filters.search) {
      query.$or = [
        { text: { $regex: filters.search, $options: 'i' } },
        { fromUsername: { $regex: filters.search, $options: 'i' } },
      ];
    }
    return messageRepository.paginate(
      query,
      { ...filters, sort: { createdAt: -1 } },
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

    // Meta only accepts free-form DMs within 24h of the contact's last
    // message. Fail fast with a clear reason instead of a Meta API error.
    const lastInbound = await messageRepository.findOne(
      { conversation: conversation._id, direction: MessageDirection.INBOUND },
      undefined,
      { sort: { createdAt: -1 } }
    );
    if (!lastInbound || Date.now() - lastInbound.createdAt.getTime() > DM_WINDOW_MS) {
      throw new BadRequestError(
        "This contact's 24-hour messaging window has closed. Meta only allows replies within 24 hours of their last message — you can respond again once they message you."
      );
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

  /** Send a manual public reply to an inbound comment from the Comments feed. */
  async replyToComment(user: AuthUser, messageId: string, text: string): Promise<IMessage> {
    const comment = await messageRepository.findOne({
      _id: messageId,
      workspace: user.workspaceId,
      type: MessageType.COMMENT,
      direction: MessageDirection.INBOUND,
    });
    if (!comment) throw new NotFoundError('Comment not found');
    if (!comment.externalId) {
      throw new BadRequestError('Comment is missing its external id and cannot be replied to');
    }

    const account = await socialAccountRepository.findWithToken(comment.socialAccount.toString());
    if (!account || !account.isActive) {
      throw new BadRequestError('The connected account for this comment is unavailable');
    }

    // Record the outbound reply as pending, then attempt delivery.
    const message = await messageRepository.create({
      workspace: comment.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.PUBLIC_REPLY,
      status: MessageStatus.PENDING,
      toId: comment.fromId,
      text,
      postId: comment.postId,
      isAutomated: false,
    });

    try {
      const result = await metaClient.replyToComment(
        comment.externalId,
        text,
        account.accessToken
      );
      await messageRepository.updateById(message._id, {
        status: MessageStatus.SENT,
        externalId: result.id,
      });
      message.status = MessageStatus.SENT;
    } catch (error) {
      await messageRepository.updateById(message._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
      throw error;
    }

    await activityService.log({
      workspace: user.workspaceId,
      user: user.id,
      action: ActivityAction.MESSAGE_SENT,
      description: 'Replied to a comment',
      entityType: 'Message',
      entityId: comment._id,
    });

    return message;
  }

  /** Workspace-wide unread count for the inbox badge. */
  countUnread(workspaceId: string): Promise<number> {
    return conversationRepository.countUnreadByWorkspace(workspaceId);
  }
}

export const inboxService = new InboxService();
