import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  ActivityAction,
  AutomationStatus,
  ConversationStatus,
  LeadStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  NotificationType,
  Platform,
} from '../constants';
import { IAutomation } from '../models/automation.model';
import { ISocialAccount } from '../models/socialAccount.model';
import {
  automationRepository,
  conversationRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  socialAccountRepository,
  userRepository,
} from '../repositories';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';
import { emailService } from './email/email.service';
import { IncomingComment, IncomingMessage, metaClient, parseWebhookPayload } from './meta';
import { notificationService } from './notification.service';

/**
 * The automation engine. Processes normalized Meta webhook events:
 *  - Comments: match keywords -> public reply + private DM -> create lead.
 *  - Messages: record inbound DMs into the unified inbox.
 *
 * Per MVP constraints there is no Redis/queue; webhook handling is performed
 * inline but defensively (idempotent, best-effort, never throws to Meta).
 */
class WebhookService {
  /** Entry point: parse a raw payload and process every contained event. */
  async process(payload: unknown): Promise<void> {
    const { comments, messages } = parseWebhookPayload(payload);

    for (const comment of comments) {
      try {
        await this.handleComment(comment);
      } catch (error) {
        logger.error('Failed to handle comment event', {
          commentId: comment.commentId,
          error: (error as Error).message,
        });
      }
    }

    for (const message of messages) {
      try {
        await this.handleMessage(message);
      } catch (error) {
        logger.error('Failed to handle message event', {
          messageId: message.messageId,
          error: (error as Error).message,
        });
      }
    }
  }

  /** Resolve the connected account a webhook event belongs to. */
  private resolveAccount(
    platform: Platform,
    accountExternalId: string
  ): Promise<ISocialAccount | null> {
    return platform === Platform.INSTAGRAM
      ? socialAccountRepository.findByInstagramBusinessId(accountExternalId)
      : socialAccountRepository.findByPageId(accountExternalId);
  }

  /** Find the first active automation whose keywords match the comment text. */
  private matchAutomation(
    automations: IAutomation[],
    text: string
  ): { automation: IAutomation; keyword: string } | null {
    const haystack = text.toLowerCase();
    for (const automation of automations) {
      if (automation.status !== AutomationStatus.ACTIVE) continue;
      const matched = automation.keywords.find((kw) => haystack.includes(kw));
      if (matched) return { automation, keyword: matched };
    }
    return null;
  }

  private async handleComment(comment: IncomingComment): Promise<void> {
    const account = await this.resolveAccount(comment.platform, comment.accountExternalId);
    if (!account || !account.isActive || !account.pageId) {
      logger.debug('No active account for comment event', {
        accountExternalId: comment.accountExternalId,
      });
      return;
    }

    // Idempotency: skip if we've already recorded this comment.
    const seen = await messageRepository.existsByExternalId(
      account._id.toString(),
      comment.commentId
    );
    if (seen) return;

    // Record the inbound comment.
    await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.INBOUND,
      type: MessageType.COMMENT,
      status: MessageStatus.RECEIVED,
      fromId: comment.fromId,
      text: comment.text,
      externalId: comment.commentId,
      postId: comment.postId,
    });

    const automations = await automationRepository.findActiveMatching(
      account._id.toString(),
      comment.postId
    );
    const match = this.matchAutomation(automations, comment.text);
    if (!match) return;

    const { automation, keyword } = match;
    const now = new Date();

    // 1) Public reply to the comment.
    await this.sendPublicReply(account, automation, comment);

    // 2) Private DM to the commenter.
    await this.sendPrivateMessage(account, automation, comment);

    // 3) Lead + conversation + analytics + notifications.
    await this.registerTriggerOutcome(account, automation, comment, keyword, now);
  }

  private async sendPublicReply(
    account: ISocialAccount,
    automation: IAutomation,
    comment: IncomingComment
  ): Promise<void> {
    const msg = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.PUBLIC_REPLY,
      status: MessageStatus.PENDING,
      toId: comment.fromId,
      text: automation.publicReply,
      postId: comment.postId,
      automation: automation._id,
      isAutomated: true,
    });
    try {
      await metaClient.replyToComment(
        comment.commentId,
        automation.publicReply,
        account.accessToken
      );
      await messageRepository.updateById(msg._id, { status: MessageStatus.SENT });
    } catch (error) {
      await messageRepository.updateById(msg._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
    }
  }

  private async sendPrivateMessage(
    account: ISocialAccount,
    automation: IAutomation,
    comment: IncomingComment
  ): Promise<void> {
    const dm = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: comment.fromId,
      text: automation.privateMessage,
      automation: automation._id,
      isAutomated: true,
    });
    try {
      await metaClient.sendPrivateReply(
        account.pageId!,
        comment.commentId,
        automation.privateMessage,
        account.accessToken
      );
      await messageRepository.updateById(dm._id, { status: MessageStatus.SENT });
      await analyticsService.track(account.workspace.toString(), 'dmSent', comment.platform);
    } catch (error) {
      await messageRepository.updateById(dm._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
    }
  }

  private async registerTriggerOutcome(
    account: ISocialAccount,
    automation: IAutomation,
    comment: IncomingComment,
    keyword: string,
    now: Date
  ): Promise<void> {
    const workspaceId = account.workspace.toString();

    // Conversation (DM thread) for the unified inbox.
    const conversation = await conversationRepository.upsertForInbound({
      workspace: workspaceId,
      socialAccount: account._id.toString(),
      platform: comment.platform,
      participantId: comment.fromId,
      participantUsername: comment.fromUsername,
      participantName: comment.fromName,
      preview: automation.privateMessage,
      at: now,
    });
    // The DM we sent is outbound; the upsert above optimistically bumped unread.
    await conversationRepository.updateById(conversation._id, {
      status: ConversationStatus.UNREAD,
    });

    // Lead — upsert one per participant per account.
    const existingLead = await leadRepository.findByExternalUser(
      account._id.toString(),
      comment.fromId
    );
    let leadIsNew = false;
    const lead =
      existingLead ??
      (await (async () => {
        leadIsNew = true;
        return leadRepository.create({
          workspace: account.workspace,
          socialAccount: account._id,
          platform: comment.platform,
          externalUserId: comment.fromId,
          username: comment.fromUsername,
          name: comment.fromName,
          postId: comment.postId,
          comment: comment.text,
          conversation: conversation._id,
          automation: automation._id,
          matchedKeyword: keyword,
          status: LeadStatus.NEW,
        });
      })());

    if (!existingLead) {
      await conversationRepository.updateById(conversation._id, { lead: lead._id });
    }

    // Counters + analytics.
    await Promise.all([
      automationRepository.registerTrigger(automation._id.toString(), now),
      keywordRepository.incrementMatch(account._id.toString(), keyword),
      analyticsService.track(workspaceId, 'commentsTriggered', comment.platform, now),
      leadIsNew
        ? analyticsService.track(workspaceId, 'newLeads', comment.platform, now)
        : Promise.resolve(),
      activityService.log({
        workspace: workspaceId,
        action: ActivityAction.AUTOMATION_TRIGGERED,
        description: `Automation "${automation.name}" triggered by keyword "${keyword}"`,
        entityType: 'Automation',
        entityId: automation._id,
        metadata: { commentId: comment.commentId, keyword },
      }),
    ]);

    if (leadIsNew) {
      await this.notifyNewLead(account, lead._id.toString(), comment, keyword);
      await analyticsService.refreshWorkspaceStats(workspaceId);
    }
  }

  private async notifyNewLead(
    account: ISocialAccount,
    leadId: string,
    comment: IncomingComment,
    _keyword: string
  ): Promise<void> {
    // Notify the workspace owner. (Multi-member fan-out is a future phase.)
    const ownerUser = await userRepository.findOne({ workspace: account.workspace });
    if (!ownerUser) return;

    const leadName = comment.fromUsername || comment.fromName || comment.fromId;
    await notificationService.create({
      workspace: account.workspace.toString(),
      user: ownerUser._id.toString(),
      type: NotificationType.NEW_LEAD,
      title: 'New lead 🎯',
      body: `${leadName} engaged on ${comment.platform}.`,
      link: `/leads/${leadId}`,
    });

    if (ownerUser.notificationPreferences?.newLead) {
      await emailService.sendNewLead(
        ownerUser.email,
        ownerUser.name,
        leadName,
        comment.platform,
        `${env.CLIENT_URL.split(',')[0]}/leads/${leadId}`
      );
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    const account = await this.resolveAccount(message.platform, message.accountExternalId);
    if (!account || !account.isActive) return;

    // Ignore echoes of our own outbound messages.
    if (message.fromId === account.pageId || message.fromId === account.instagramBusinessId) {
      return;
    }

    const seen = await messageRepository.existsByExternalId(
      account._id.toString(),
      message.messageId
    );
    if (seen) return;

    const now = message.createdTime ?? new Date();
    const conversation = await conversationRepository.upsertForInbound({
      workspace: account.workspace.toString(),
      socialAccount: account._id.toString(),
      platform: message.platform,
      participantId: message.fromId,
      preview: message.text,
      at: now,
    });

    await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      conversation: conversation._id,
      platform: message.platform,
      direction: MessageDirection.INBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.RECEIVED,
      fromId: message.fromId,
      toId: message.toId,
      text: message.text,
      externalId: message.messageId,
    });

    await analyticsService.track(
      account.workspace.toString(),
      'messagesReceived',
      message.platform,
      now
    );
  }
}

export const webhookService = new WebhookService();
