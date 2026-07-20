import { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  ActivityAction,
  AutomationTrigger,
  LeadStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  NotificationType,
  Platform,
  StudioKeywordMode,
  StudioPostScope,
} from '../constants';
import { IStudioAutomation } from '../models/studioAutomation.model';
import { ISocialAccount } from '../models/socialAccount.model';
import { IConversation } from '../models/conversation.model';
import {
  conversationRepository,
  leadRepository,
  messageRepository,
  studioAutomationRepository,
  userRepository,
} from '../repositories';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';
import { emailService } from './email/email.service';
import { featureService } from './feature.service';
import { linkTrackingService } from './linkTracking.service';
import { subscriptionService } from './subscription.service';
import { IncomingComment, metaClient } from './meta';
import { notificationService } from './notification.service';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Automation Studio (v2 trial) webhook engine. Runs ONLY when no classic
 * automation matched a comment, so the existing feature keeps priority and
 * its behavior is unchanged (Meta allows a single private reply per comment).
 *
 * Extras over the classic engine: any/contains/exact-word keyword modes,
 * exclude keywords, rotating public reply variations, DM link buttons, and
 * an optional once-per-user guard.
 */
class StudioEngineService {
  /** Whether `automation` should fire for this comment text. */
  private matchText(
    automation: IStudioAutomation,
    haystack: string
  ): { matched: boolean; keyword?: string } {
    if (automation.excludeKeywords.some((kw) => haystack.includes(kw))) {
      return { matched: false };
    }
    switch (automation.keywordMode) {
      case StudioKeywordMode.ANY:
        return { matched: true };
      case StudioKeywordMode.EXACT: {
        const keyword = automation.keywords.find((kw) =>
          new RegExp(`(^|\\W)${escapeRegExp(kw)}($|\\W)`, 'i').test(haystack)
        );
        return { matched: Boolean(keyword), keyword };
      }
      case StudioKeywordMode.CONTAINS:
      default: {
        const keyword = automation.keywords.find((kw) => haystack.includes(kw));
        return { matched: Boolean(keyword), keyword };
      }
    }
  }

  /** Has this automation already DM'd this participant? (once-per-user guard) */
  private alreadyMessaged(
    account: ISocialAccount,
    automation: IStudioAutomation,
    participantId: string
  ): Promise<boolean> {
    return messageRepository.exists({
      socialAccount: account._id,
      automation: automation._id,
      toId: participantId,
      type: MessageType.DIRECT_MESSAGE,
      direction: MessageDirection.OUTBOUND,
    });
  }

  /**
   * Try to handle a comment with a Studio automation.
   * Returns true when an automation fired (so callers can log accordingly).
   * The inbound comment itself was already recorded by the caller.
   */
  /**
   * DM pipeline entry: run DM- or story-triggered Studio automations for an
   * inbound direct message. Returns true when one replied. Buttons are
   * appended as text lines (DM replies have no button template).
   */
  async handleIncomingDm(
    account: ISocialAccount,
    message: { fromId: string; text: string; replyToStoryId?: string; platform: Platform },
    conversationId: Types.ObjectId
  ): Promise<boolean> {
    const studioEnabled = await featureService.isEnabled('studio', account.workspace.toString());
    if (!studioEnabled) return false;
    const { entitlements } = await subscriptionService.getEntitlements(
      account.workspace.toString()
    );
    if (!entitlements.studio) return false;

    const trigger = message.replyToStoryId ? AutomationTrigger.STORY : AutomationTrigger.DM;
    let candidates = await studioAutomationRepository.findActiveByTrigger(
      account._id.toString(),
      trigger
    );
    if (trigger === AutomationTrigger.STORY) {
      // postScope/postIds double as story targeting for story triggers.
      candidates = candidates.filter(
        (a) =>
          a.postScope === StudioPostScope.ALL || a.postIds.includes(message.replyToStoryId!)
      );
    }

    const haystack = message.text.toLowerCase();
    for (const automation of candidates) {
      const result = this.matchText(automation, haystack);
      if (!result.matched) continue;
      if (
        automation.oncePerUser &&
        (await this.alreadyMessaged(account, automation, message.fromId))
      ) {
        continue;
      }

      const linkSource = {
        workspaceId: account.workspace.toString(),
        studioAutomationId: automation._id.toString(),
      };
      const buttonLines = automation.dmButtons.length
        ? '\n\n' +
          (
            await Promise.all(
              automation.dmButtons.map(
                async (b) => `${b.title}: ${await linkTrackingService.wrapUrl(linkSource, b.url)}`
              )
            )
          ).join('\n')
        : '';
      const replyText =
        (await linkTrackingService.wrapText(linkSource, automation.dmMessage)) + buttonLines;

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
        await studioAutomationRepository.updateById(automation._id, {
          $inc: { triggerCount: 1, dmSentCount: 1 },
          $set: { lastTriggeredAt: new Date() },
        });
        await analyticsService.track(account.workspace.toString(), 'dmSent', message.platform);
        logger.info('Studio DM automation replied', { automation: automation.name, trigger });
        return true;
      } catch (error) {
        logger.error('Studio DM automation reply FAILED', {
          automation: automation.name,
          error: (error as Error).message,
        });
        await messageRepository.updateById(dm._id, {
          status: MessageStatus.FAILED,
          error: (error as Error).message,
        });
        return false;
      }
    }
    return false;
  }

  async handleComment(account: ISocialAccount, comment: IncomingComment): Promise<boolean> {
    // Honor the admin kill switch / rollout even for already-active automations.
    const studioEnabled = await featureService.isEnabled('studio', account.workspace.toString());
    if (!studioEnabled) return false;
    // And the plan entitlement — Studio automations only run on plans that include it.
    const { entitlements } = await subscriptionService.getEntitlements(
      account.workspace.toString()
    );
    if (!entitlements.studio) return false;

    const candidates = await studioAutomationRepository.findActiveMatching(
      account._id.toString(),
      comment.postId
    );
    if (!candidates.length) return false;

    const haystack = comment.text.toLowerCase();
    let match: { automation: IStudioAutomation; keyword?: string } | null = null;
    for (const automation of candidates) {
      const result = this.matchText(automation, haystack);
      if (!result.matched) continue;
      if (
        automation.oncePerUser &&
        (await this.alreadyMessaged(account, automation, comment.fromId))
      ) {
        logger.info('Studio automation skipped: once-per-user guard', {
          automation: automation.name,
          fromId: comment.fromId,
        });
        continue;
      }
      match = { automation, keyword: result.keyword };
      break;
    }
    if (!match) return false;

    const { automation, keyword } = match;
    logger.info('Studio automation matched — sending replies', {
      automation: automation.name,
      keywordMode: automation.keywordMode,
      keyword,
      commentId: comment.commentId,
    });
    const now = new Date();

    // Thread must exist before the DM so the outbound message links to it.
    const conversation = await conversationRepository.upsertForInbound({
      workspace: account.workspace.toString(),
      socialAccount: account._id.toString(),
      platform: comment.platform,
      participantId: comment.fromId,
      participantUsername: comment.fromUsername,
      participantName: comment.fromName,
      preview: automation.dmMessage,
      at: now,
    });

    if (automation.publicReplyEnabled && automation.publicReplies.length) {
      await this.sendPublicReply(account, automation, comment);
    }
    const dmSent = await this.sendPrivateMessage(account, automation, comment, conversation._id);
    await this.registerTriggerOutcome(
      account,
      automation,
      comment,
      keyword,
      now,
      conversation,
      dmSent
    );
    return true;
  }

  /** Send one randomly chosen public reply variation. */
  private async sendPublicReply(
    account: ISocialAccount,
    automation: IStudioAutomation,
    comment: IncomingComment
  ): Promise<void> {
    const variation =
      automation.publicReplies[Math.floor(Math.random() * automation.publicReplies.length)];
    const msg = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      platform: comment.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.PUBLIC_REPLY,
      status: MessageStatus.PENDING,
      toId: comment.fromId,
      text: variation,
      postId: comment.postId,
      automation: automation._id,
      isAutomated: true,
    });
    try {
      await metaClient.replyToComment(comment.commentId, variation, account.accessToken);
      await messageRepository.updateById(msg._id, { status: MessageStatus.SENT });
      logger.info('Studio public reply sent', { commentId: comment.commentId });
    } catch (error) {
      logger.error('Studio public reply FAILED', {
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
    automation: IStudioAutomation,
    comment: IncomingComment,
    conversationId: Types.ObjectId
  ): Promise<boolean> {
    // Route DM text links + button URLs through tracked redirects (click stats).
    const linkSource = {
      workspaceId: account.workspace.toString(),
      studioAutomationId: automation._id.toString(),
    };
    const dmText = await linkTrackingService.wrapText(linkSource, automation.dmMessage);
    const buttons = await Promise.all(
      automation.dmButtons.map(async (b) => ({
        title: b.title,
        url: await linkTrackingService.wrapUrl(linkSource, b.url),
      }))
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
      await metaClient.sendPrivateReplyWithButtons(
        account.pageId!,
        comment.commentId,
        dmText,
        buttons,
        account.accessToken
      );
      await messageRepository.updateById(dm._id, { status: MessageStatus.SENT });
      await analyticsService.track(account.workspace.toString(), 'dmSent', comment.platform);
      logger.info('Studio private DM sent', {
        commentId: comment.commentId,
        toId: comment.fromId,
        buttons: automation.dmButtons.length,
      });
      return true;
    } catch (error) {
      logger.error('Studio private DM FAILED', {
        commentId: comment.commentId,
        toId: comment.fromId,
        error: (error as Error).message,
      });
      await messageRepository.updateById(dm._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
      return false;
    }
  }

  private async registerTriggerOutcome(
    account: ISocialAccount,
    automation: IStudioAutomation,
    comment: IncomingComment,
    keyword: string | undefined,
    now: Date,
    conversation: IConversation,
    dmSent: boolean
  ): Promise<void> {
    const workspaceId = account.workspace.toString();

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
          matchedKeyword: keyword,
          status: LeadStatus.NEW,
        });
      })());

    if (!existingLead) {
      await conversationRepository.updateById(conversation._id, { lead: lead._id });
    }

    await Promise.all([
      studioAutomationRepository.registerTrigger(automation._id.toString(), now, dmSent),
      analyticsService.track(workspaceId, 'commentsTriggered', comment.platform, now),
      leadIsNew
        ? analyticsService.track(workspaceId, 'newLeads', comment.platform, now)
        : Promise.resolve(),
      activityService.log({
        workspace: workspaceId,
        action: ActivityAction.AUTOMATION_TRIGGERED,
        description: keyword
          ? `Studio automation "${automation.name}" triggered by keyword "${keyword}"`
          : `Studio automation "${automation.name}" triggered by a comment`,
        entityType: 'StudioAutomation',
        entityId: automation._id,
        metadata: { commentId: comment.commentId, keyword },
      }),
    ]);

    if (leadIsNew) {
      await this.notifyNewLead(account, lead._id.toString(), comment);
      await analyticsService.refreshWorkspaceStats(workspaceId);
    }
  }

  private async notifyNewLead(
    account: ISocialAccount,
    leadId: string,
    comment: IncomingComment
  ): Promise<void> {
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
}

export const studioEngineService = new StudioEngineService();
