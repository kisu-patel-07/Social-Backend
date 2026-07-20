import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  ActivityAction,
  AutomationStatus,
  AutomationTrigger,
  LeadSource,
  LeadStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  NotificationType,
  Platform,
} from '../constants';
import { IAutomation } from '../models/automation.model';
import { IConversation } from '../models/conversation.model';
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
import { linkTrackingService } from './linkTracking.service';
import { studioEngineService } from './studioEngine.service';
import { subscriptionService } from './subscription.service';

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
    logger.info('Webhook payload parsed', {
      comments: comments.length,
      messages: messages.length,
    });

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
    logger.info('Comment event received', {
      platform: comment.platform,
      accountExternalId: comment.accountExternalId,
      commentId: comment.commentId,
      fromId: comment.fromId,
      fromUsername: comment.fromUsername,
      text: comment.text,
    });

    const account = await this.resolveAccount(comment.platform, comment.accountExternalId);
    if (!account || !account.isActive || !account.pageId) {
      logger.warn('Comment dropped: no active connected account matches this event', {
        accountExternalId: comment.accountExternalId,
        found: Boolean(account),
        isActive: account?.isActive,
        hasPageId: Boolean(account?.pageId),
      });
      return;
    }

    // Idempotency: skip if we've already recorded this comment.
    const seen = await messageRepository.existsByExternalId(
      account._id.toString(),
      comment.commentId
    );
    if (seen) {
      logger.info('Comment dropped: already processed (idempotency)', {
        commentId: comment.commentId,
      });
      return;
    }

    // Record the inbound comment.
    await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.INBOUND,
      type: MessageType.COMMENT,
      status: MessageStatus.RECEIVED,
      fromId: comment.fromId,
      fromUsername: comment.fromUsername ?? comment.fromName,
      text: comment.text,
      externalId: comment.commentId,
      postId: comment.postId,
    });

    // Trial/subscription gate: the comment stays recorded in the inbox, but
    // no automated replies go out for lapsed workspaces.
    const access = await subscriptionService.getAccessState(account.workspace.toString());
    if (!access.allowed) {
      logger.info('Automation skipped: subscription inactive', {
        workspace: account.workspace.toString(),
        reason: access.reason,
        commentId: comment.commentId,
      });
      return;
    }

    // Plan volume gate: stop automated replies once the monthly quota is spent.
    const { limits } = await subscriptionService.getEntitlements(account.workspace.toString());
    if (limits.monthlyMessages !== -1) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const sentThisMonth = await messageRepository.count({
        workspace: account.workspace,
        direction: MessageDirection.OUTBOUND,
        createdAt: { $gte: startOfMonth },
      });
      if (sentThisMonth >= limits.monthlyMessages) {
        logger.info('Automation skipped: monthly reply limit reached', {
          workspace: account.workspace.toString(),
          limit: limits.monthlyMessages,
          commentId: comment.commentId,
        });
        return;
      }
    }

    const automations = await automationRepository.findActiveMatching(
      account._id.toString(),
      comment.postId
    );
    const match = this.matchAutomation(automations, comment.text);
    if (!match) {
      // Classic automations take priority; give Automation Studio (v2 trial)
      // a chance only when none matched, since Meta allows a single private
      // reply per comment.
      const handledByStudio = await studioEngineService.handleComment(account, comment);
      if (!handledByStudio) {
        logger.info('Comment recorded but no automation matched', {
          commentId: comment.commentId,
          text: comment.text,
          candidateAutomations: automations.map((a) => ({ name: a.name, keywords: a.keywords })),
        });
      }
      return;
    }

    const { automation, keyword } = match;
    logger.info('Automation matched — sending replies', {
      automation: automation.name,
      keyword,
      commentId: comment.commentId,
    });
    const now = new Date();

    // Ensure the DM thread exists *before* we send the automated DM, so the
    // outbound message can be linked to it and appears in the conversation
    // view — otherwise the thread shows empty even though the list preview
    // (which reads the conversation's lastMessagePreview) has text.
    const conversation = await conversationRepository.upsertForInbound({
      workspace: account.workspace.toString(),
      socialAccount: account._id.toString(),
      platform: comment.platform,
      participantId: comment.fromId,
      participantUsername: comment.fromUsername,
      participantName: comment.fromName,
      preview: automation.privateMessage,
      at: now,
    });

    // 1) Public reply to the comment.
    await this.sendPublicReply(account, automation, comment);

    // 2) Private DM to the commenter, linked to the conversation thread.
    await this.sendPrivateMessage(account, automation, comment, conversation._id);

    // 3) Lead + analytics + notifications.
    await this.registerTriggerOutcome(account, automation, comment, keyword, now, conversation);
  }

  private async sendPublicReply(
    account: ISocialAccount,
    automation: IAutomation,
    comment: IncomingComment
  ): Promise<void> {
    // DM-triggered automations have no public reply; nothing to send.
    if (!automation.publicReply) return;
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
      logger.info('Public reply sent', { commentId: comment.commentId });
    } catch (error) {
      logger.error('Public reply FAILED', {
        commentId: comment.commentId,
        error: (error as Error).message,
      });
      await messageRepository.updateById(msg._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
    }
  }

  private async sendPrivateMessage(
    account: ISocialAccount,
    automation: IAutomation,
    comment: IncomingComment,
    conversationId: Types.ObjectId
  ): Promise<void> {
    // Route any links through tracked redirects so the automation reports clicks.
    const dmText = await linkTrackingService.wrapText(
      { workspaceId: account.workspace.toString(), automationId: automation._id.toString() },
      automation.privateMessage
    );
    const dm = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      conversation: conversationId,
      platform: comment.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: comment.fromId,
      text: dmText,
      automation: automation._id,
      isAutomated: true,
    });
    try {
      await metaClient.sendPrivateReply(
        account.pageId!,
        comment.commentId,
        dmText,
        account.accessToken
      );
      await messageRepository.updateById(dm._id, { status: MessageStatus.SENT });
      await analyticsService.track(account.workspace.toString(), 'dmSent', comment.platform);
      logger.info('Private DM sent', { commentId: comment.commentId, toId: comment.fromId });
    } catch (error) {
      logger.error('Private DM FAILED', {
        commentId: comment.commentId,
        toId: comment.fromId,
        error: (error as Error).message,
      });
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
    now: Date,
    conversation: IConversation
  ): Promise<void> {
    const workspaceId = account.workspace.toString();

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
          source: LeadSource.COMMENT,
          lastInteractionAt: now,
          postId: comment.postId,
          comment: comment.text,
          conversation: conversation._id,
          automation: automation._id,
          matchedKeyword: keyword,
          status: LeadStatus.NEW,
        });
      })());

    if (existingLead) {
      await leadRepository.registerInteraction(existingLead._id.toString(), now, {
        username: comment.fromUsername,
        name: comment.fromName,
      });
    } else {
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
      await this.notifyNewLead(
        account,
        lead._id.toString(),
        comment.fromUsername || comment.fromName || comment.fromId,
        comment.platform
      );
      await analyticsService.refreshWorkspaceStats(workspaceId);
    }
  }

  private async notifyNewLead(
    account: ISocialAccount,
    leadId: string,
    leadName: string,
    platform: Platform
  ): Promise<void> {
    // Notify the workspace owner. (Multi-member fan-out is a future phase.)
    const ownerUser = await userRepository.findOne({ workspace: account.workspace });
    if (!ownerUser) return;

    await notificationService.create({
      workspace: account.workspace.toString(),
      user: ownerUser._id.toString(),
      type: NotificationType.NEW_LEAD,
      title: 'New lead 🎯',
      body: `${leadName} engaged on ${platform}.`,
      link: `/leads?id=${leadId}`,
    });

    if (ownerUser.notificationPreferences?.newLead) {
      await emailService.sendNewLead(
        ownerUser.email,
        ownerUser.name,
        leadName,
        platform,
        `${env.CLIENT_URL.split(',')[0]}/leads?id=${leadId}`
      );
    }
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    logger.info('DM event received', {
      platform: message.platform,
      accountExternalId: message.accountExternalId,
      fromId: message.fromId,
      text: message.text,
    });

    const account = await this.resolveAccount(message.platform, message.accountExternalId);
    if (!account || !account.isActive) {
      logger.warn('DM dropped: no active connected account matches this event', {
        accountExternalId: message.accountExternalId,
        found: Boolean(account),
        isActive: account?.isActive,
      });
      return;
    }

    // Ignore echoes of our own outbound messages.
    if (message.fromId === account.pageId || message.fromId === account.instagramBusinessId) {
      logger.info('DM dropped: echo of our own outbound message', {
        messageId: message.messageId,
      });
      return;
    }

    const seen = await messageRepository.existsByExternalId(
      account._id.toString(),
      message.messageId
    );
    if (seen) {
      logger.info('DM dropped: already processed (idempotency)', {
        messageId: message.messageId,
      });
      return;
    }

    // DM webhooks only carry the sender's ID; fetch their profile once per
    // new contact so the inbox can show a real name instead of "Unknown".
    const existing = await conversationRepository.findByParticipant(
      account._id.toString(),
      message.fromId
    );
    const profile = existing?.participantUsername
      ? null
      : await metaClient.getUserProfile(message.fromId, account.accessToken, message.platform);

    const now = message.createdTime ?? new Date();
    const conversation = await conversationRepository.upsertForInbound({
      workspace: account.workspace.toString(),
      socialAccount: account._id.toString(),
      platform: message.platform,
      participantId: message.fromId,
      participantUsername: profile?.username ?? profile?.name,
      participantName: profile?.name,
      participantAvatarUrl: profile?.profilePic,
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

    await this.upsertDmContact(account, message, conversation, now);

    // DM keyword automations: auto-reply inside the thread when a keyword hits.
    await this.runDmAutomations(account, message, conversation._id, now);
  }

  /** Match and run DM-triggered automations for an inbound direct message. */
  private async runDmAutomations(
    account: ISocialAccount,
    message: IncomingMessage,
    conversationId: Types.ObjectId,
    now: Date
  ): Promise<void> {
    // Story replies: match story-triggered automations first (pinned to this
    // story or "any story"; empty keywords = every reply triggers).
    let match: { automation: IAutomation; keyword?: string } | null = null;
    if (message.replyToStoryId) {
      const storyAutomations = (
        await automationRepository.findActiveDmAutomations(
          account._id.toString(),
          AutomationTrigger.STORY
        )
      ).filter((a) => !a.targetPostId || a.targetPostId === message.replyToStoryId);
      match =
        storyAutomations.find((a) => a.keywords.length === 0) != null
          ? { automation: storyAutomations.find((a) => a.keywords.length === 0)! }
          : this.matchAutomation(storyAutomations, message.text);
    }

    // Fall through to DM keyword automations.
    if (!match) {
      const automations = await automationRepository.findActiveDmAutomations(
        account._id.toString()
      );
      if (automations.length === 0) return;
      match = this.matchAutomation(automations, message.text);
    }
    if (!match) return;

    // Same billing gates as comment automations.
    const access = await subscriptionService.getAccessState(account.workspace.toString());
    if (!access.allowed) {
      logger.info('DM automation skipped: subscription inactive', {
        workspace: account.workspace.toString(),
      });
      return;
    }
    const { limits } = await subscriptionService.getEntitlements(account.workspace.toString());
    if (limits.monthlyMessages !== -1) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const sentThisMonth = await messageRepository.count({
        workspace: account.workspace,
        direction: MessageDirection.OUTBOUND,
        createdAt: { $gte: startOfMonth },
      });
      if (sentThisMonth >= limits.monthlyMessages) {
        logger.info('DM automation skipped: monthly reply limit reached', {
          workspace: account.workspace.toString(),
        });
        return;
      }
    }

    const { automation, keyword } = match;
    const replyText = await linkTrackingService.wrapText(
      { workspaceId: account.workspace.toString(), automationId: automation._id.toString() },
      automation.privateMessage
    );

    const dm = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      conversation: conversationId,
      platform: message.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: message.fromId,
      text: replyText,
      automation: automation._id,
      isAutomated: true,
    });
    try {
      await metaClient.sendDirectMessage(
        account.pageId!,
        message.fromId,
        replyText,
        account.accessToken
      );
      await messageRepository.updateById(dm._id, { status: MessageStatus.SENT });
      await automationRepository.registerTrigger(automation._id.toString(), now);
      await analyticsService.track(account.workspace.toString(), 'dmSent', message.platform);
      logger.info('DM automation replied', {
        automation: automation.name,
        keyword,
        toId: message.fromId,
      });
    } catch (error) {
      logger.error('DM automation reply FAILED', {
        automation: automation.name,
        error: (error as Error).message,
      });
      await messageRepository.updateById(dm._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Anyone who DMs the account becomes a contact (Manychat-style "subscribed"):
   * they can then be tagged, segmented, exported and followed up from the CRM.
   */
  private async upsertDmContact(
    account: ISocialAccount,
    message: IncomingMessage,
    conversation: IConversation,
    now: Date
  ): Promise<void> {
    const workspaceId = account.workspace.toString();
    const existingLead = await leadRepository.findByExternalUser(
      account._id.toString(),
      message.fromId
    );

    if (existingLead) {
      await leadRepository.registerInteraction(existingLead._id.toString(), now, {
        username: conversation.participantUsername,
        name: conversation.participantName,
        avatarUrl: conversation.participantAvatarUrl,
      });
      if (!existingLead.conversation) {
        await leadRepository.updateById(existingLead._id, { conversation: conversation._id });
      }
      return;
    }

    const lead = await leadRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: message.platform,
      externalUserId: message.fromId,
      username: conversation.participantUsername,
      name: conversation.participantName,
      avatarUrl: conversation.participantAvatarUrl,
      source: LeadSource.DM,
      lastInteractionAt: now,
      conversation: conversation._id,
      status: LeadStatus.NEW,
    });
    await conversationRepository.updateById(conversation._id, { lead: lead._id });
    await analyticsService.track(workspaceId, 'newLeads', message.platform, now);
    await this.notifyNewLead(
      account,
      lead._id.toString(),
      conversation.participantUsername || conversation.participantName || message.fromId,
      message.platform
    );
    await analyticsService.refreshWorkspaceStats(workspaceId);
  }
}

export const webhookService = new WebhookService();
