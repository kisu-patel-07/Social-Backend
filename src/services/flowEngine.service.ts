import { Types } from 'mongoose';
import { logger } from '../config/logger';
import { FlowStep, MessageDirection, MessageStatus, MessageType } from '../constants';
import { FlowRunModel, IFlowRun } from '../models/flowRun.model';
import { IStudioAutomation } from '../models/studioAutomation.model';
import { ISocialAccount } from '../models/socialAccount.model';
import {
  conversationRepository,
  leadRepository,
  messageRepository,
  socialAccountRepository,
  studioAutomationRepository,
} from '../repositories';
import { addDays } from '../utils/date';
import { analyticsService } from './analytics.service';
import { linkTrackingService } from './linkTracking.service';
import { metaClient } from './meta';
import { IncomingComment, IncomingMessage, IncomingPostback } from './meta/meta.types';

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const FLOW_RUN_TTL_DAYS = 7;
const DEFAULT_LINK_BUTTON = 'Send me the link';
const DEFAULT_FOLLOW_BUTTON = "I'm following ✅";
const DEFAULT_FOLLOW_MSG = 'Follow us first, then tap below to get your link 👇';
const DEFAULT_EMAIL_MSG = "What's the best email to send this to? 📧";
const DEFAULT_OPENING_MSG = "Tap below and I'll send it right over 👇";
const DEFAULT_FOLLOWUP_MSG = 'Just checking in — did you grab the link? 😊';

type Recipient = { comment_id: string } | { id: string };

/**
 * Drives multi-step Studio DM flows (follow-gate → email capture → click-to-
 * deliver → link → follow-up). State lives in FlowRun; the engine is advanced by
 * webhook events (button-click postbacks, text replies) and the follow-up cron.
 */
class FlowEngineService {
  /** True when an automation has any flow gate configured. */
  hasFlow(automation: IStudioAutomation): boolean {
    const f = automation.flow;
    return Boolean(f && (f.requireFollow || f.askEmail || f.deliverOnClick || f.followUpEnabled));
  }

  private buildPayload(runId: string, action: 'follow' | 'link'): string {
    return `flow:${runId}:${action}`;
  }

  parsePayload(payload: string): { runId: string; action: 'follow' | 'link' } | null {
    const m = /^flow:([a-f0-9]{24}):(follow|link)$/i.exec(payload);
    return m ? { runId: m[1], action: m[2] as 'follow' | 'link' } : null;
  }

  /** Append the run id to our /r/<slug> links so this user's click is attributable. */
  private tagLinks(text: string, runId: string): string {
    return text.replace(/(\/r\/[A-Za-z0-9]+)(?![?\w])/g, `$1?fr=${runId}`);
  }

  private linkSource(account: ISocialAccount, automation: IStudioAutomation) {
    return {
      workspaceId: account.workspace.toString(),
      studioAutomationId: automation._id.toString(),
    };
  }

  private async setStep(runId: Types.ObjectId, patch: Partial<IFlowRun>): Promise<void> {
    await FlowRunModel.updateOne({ _id: runId }, { $set: patch }).exec();
  }

  /** Record + send a plain-text DM to a recipient; returns whether it sent. */
  private async sendText(
    account: ISocialAccount,
    run: IFlowRun,
    recipient: Recipient,
    text: string
  ): Promise<boolean> {
    const msg = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      conversation: run.conversation,
      platform: run.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: run.participantId,
      text,
      automation: run.studioAutomation,
      isAutomated: true,
    });
    try {
      if ('comment_id' in recipient) {
        await metaClient.sendPrivateReply(
          account.pageId!,
          recipient.comment_id,
          text,
          account.accessToken
        );
      } else {
        await metaClient.sendDirectMessage(
          account.pageId!,
          recipient.id,
          text,
          account.accessToken
        );
      }
      await messageRepository.updateById(msg._id, { status: MessageStatus.SENT });
      return true;
    } catch (error) {
      logger.error('Flow DM send failed', { error: (error as Error).message });
      await messageRepository.updateById(msg._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /** Record + send a DM carrying a single postback button; returns whether it sent. */
  private async sendPostback(
    account: ISocialAccount,
    run: IFlowRun,
    recipient: Recipient,
    text: string,
    buttonTitle: string,
    action: 'follow' | 'link'
  ): Promise<boolean> {
    const msg = await messageRepository.create({
      workspace: account.workspace,
      socialAccount: account._id,
      conversation: run.conversation,
      platform: run.platform,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.DIRECT_MESSAGE,
      status: MessageStatus.PENDING,
      toId: run.participantId,
      text,
      automation: run.studioAutomation,
      isAutomated: true,
    });
    try {
      await metaClient.sendMessageWithPostbacks(
        account.pageId!,
        recipient,
        text,
        [{ title: buttonTitle, payload: this.buildPayload(run._id.toString(), action) }],
        account.accessToken
      );
      await messageRepository.updateById(msg._id, { status: MessageStatus.SENT });
      return true;
    } catch (error) {
      logger.error('Flow postback DM send failed', { error: (error as Error).message });
      await messageRepository.updateById(msg._id, {
        status: MessageStatus.FAILED,
        error: (error as Error).message,
      });
      return false;
    }
  }

  // ---- Steps -----------------------------------------------------------------

  private async sendFollowGate(
    account: ISocialAccount,
    automation: IStudioAutomation,
    run: IFlowRun,
    recipient: Recipient
  ): Promise<boolean> {
    await this.setStep(run._id, { step: FlowStep.AWAIT_FOLLOW });
    const text = automation.flow?.followMessage || DEFAULT_FOLLOW_MSG;
    return this.sendPostback(account, run, recipient, text, DEFAULT_FOLLOW_BUTTON, 'follow');
  }

  private async sendEmailAsk(
    account: ISocialAccount,
    automation: IStudioAutomation,
    run: IFlowRun,
    recipient: Recipient
  ): Promise<boolean> {
    await this.setStep(run._id, { step: FlowStep.AWAIT_EMAIL });
    const text = automation.flow?.emailMessage || DEFAULT_EMAIL_MSG;
    return this.sendText(account, run, recipient, text);
  }

  private async sendOpening(
    account: ISocialAccount,
    automation: IStudioAutomation,
    run: IFlowRun,
    recipient: Recipient
  ): Promise<boolean> {
    await this.setStep(run._id, { step: FlowStep.AWAIT_CLICK });
    const f = automation.flow;
    const text = f?.openingMessage || automation.dmMessage || DEFAULT_OPENING_MSG;
    const label = f?.openingButtonLabel || DEFAULT_LINK_BUTTON;
    return this.sendPostback(account, run, recipient, text, label, 'link');
  }

  private async deliverLink(
    account: ISocialAccount,
    automation: IStudioAutomation,
    run: IFlowRun,
    recipient: Recipient
  ): Promise<boolean> {
    const source = this.linkSource(account, automation);
    const buttonLines = automation.dmButtons.length
      ? '\n\n' +
        (
          await Promise.all(
            automation.dmButtons.map(
              async (b) => `${b.title}: ${await linkTrackingService.wrapUrl(source, b.url)}`
            )
          )
        ).join('\n')
      : '';
    let text = (await linkTrackingService.wrapText(source, automation.dmMessage)) + buttonLines;
    // Tag our short links with the run id so this user's click is attributable
    // (drives the follow-up and per-user click stats).
    text = this.tagLinks(text, run._id.toString());

    const sent = await this.sendText(account, run, recipient, text);
    await this.setStep(run._id, { step: FlowStep.LINK_SENT, linkSentAt: new Date() });
    if (sent) {
      if (run.conversation) {
        await conversationRepository.setLastMessagePreview(
          run.conversation.toString(),
          text,
          new Date()
        );
      }
      await studioAutomationRepository.updateById(automation._id, { $inc: { dmSentCount: 1 } });
      await analyticsService.track(account.workspace.toString(), 'dmSent', run.platform);
    }
    return sent;
  }

  // ---- Entry points ----------------------------------------------------------

  /**
   * Kick off a flow for a commenter. Creates/refreshes the run and sends the
   * first pending step as the opening private reply to their comment.
   */
  async startFromComment(
    account: ISocialAccount,
    automation: IStudioAutomation,
    comment: IncomingComment,
    conversationId: Types.ObjectId,
    lead?: Types.ObjectId
  ): Promise<boolean> {
    const now = new Date();
    const run = await FlowRunModel.findOneAndUpdate(
      { studioAutomation: automation._id, participantId: comment.fromId },
      {
        $set: {
          workspace: account.workspace,
          socialAccount: account._id,
          conversation: conversationId,
          ...(lead ? { lead } : {}),
          platform: comment.platform,
          step: FlowStep.AWAIT_CLICK,
          linkClicked: false,
          expiresAt: addDays(now, FLOW_RUN_TTL_DAYS),
        },
        $unset: { email: '', linkTrackingSlug: '', linkSentAt: '', followUpSentAt: '' },
      },
      { new: true, upsert: true }
    ).exec();

    const f = automation.flow;
    if (!run || !f) return false;
    const recipient: Recipient = { comment_id: comment.commentId };
    // First pending gate, in order: follow → email → click → link.
    if (f.requireFollow) return this.sendFollowGate(account, automation, run, recipient);
    if (f.askEmail) return this.sendEmailAsk(account, automation, run, recipient);
    if (f.deliverOnClick) return this.sendOpening(account, automation, run, recipient);
    return this.deliverLink(account, automation, run, recipient);
  }

  /** Advance a flow when the user taps a flow button (postback webhook). */
  async handlePostback(account: ISocialAccount, postback: IncomingPostback): Promise<boolean> {
    const parsed = this.parsePayload(postback.payload);
    if (!parsed) return false;
    const run = await FlowRunModel.findById(parsed.runId).exec();
    if (!run || run.participantId !== postback.fromId) return false;
    const automation = await studioAutomationRepository.findById(run.studioAutomation.toString());
    const f = automation?.flow;
    if (!automation || !f) return false;
    const recipient: Recipient = { id: postback.fromId };

    if (parsed.action === 'follow' && run.step === FlowStep.AWAIT_FOLLOW) {
      if (f.askEmail && !run.email) return this.sendEmailAsk(account, automation, run, recipient);
      if (f.deliverOnClick) return this.sendOpening(account, automation, run, recipient);
      return this.deliverLink(account, automation, run, recipient);
    }
    if (parsed.action === 'link' && run.step === FlowStep.AWAIT_CLICK) {
      return this.deliverLink(account, automation, run, recipient);
    }
    return false;
  }

  /**
   * If this inbound DM is a reply the flow is waiting on (an email), capture it
   * and advance. Returns true when the message was consumed by a flow.
   */
  async handleText(account: ISocialAccount, message: IncomingMessage): Promise<boolean> {
    const run = await FlowRunModel.findOne({
      socialAccount: account._id,
      participantId: message.fromId,
      step: FlowStep.AWAIT_EMAIL,
    }).exec();
    if (!run) return false;

    const recipient: Recipient = { id: message.fromId };
    const email = message.text.match(EMAIL_REGEX)?.[0];
    if (!email) {
      await this.sendText(
        account,
        run,
        recipient,
        "Hmm, that doesn't look like an email — mind sending it again?"
      );
      return true;
    }
    await this.setStep(run._id, { email });
    const lead = await leadRepository.findByExternalUser(account._id.toString(), message.fromId);
    if (lead) {
      await leadRepository.updateById(lead._id.toString(), { email }).catch(() => undefined);
    }
    const automation = await studioAutomationRepository.findById(run.studioAutomation.toString());
    const f = automation?.flow;
    if (!automation || !f) return true;
    run.email = email;
    if (f.deliverOnClick) await this.sendOpening(account, automation, run, recipient);
    else await this.deliverLink(account, automation, run, recipient);
    return true;
  }

  /** Mark a run's link as clicked (called from the /r/:slug redirect). */
  async markLinkClicked(runId: string): Promise<void> {
    if (!/^[a-f0-9]{24}$/i.test(runId)) return;
    await FlowRunModel.updateOne(
      { _id: runId },
      { $set: { linkClicked: true, step: FlowStep.DONE } }
    ).exec();
  }

  /**
   * Send follow-up DMs for links that went unclicked past their delay. Invoked
   * by a scheduled job (cron).
   */
  async runFollowUps(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const runs = await FlowRunModel.find({
      step: FlowStep.LINK_SENT,
      linkClicked: false,
      followUpSentAt: { $exists: false },
      linkSentAt: { $exists: true },
    })
      .limit(200)
      .exec();

    let sent = 0;
    for (const run of runs) {
      const automation = await studioAutomationRepository.findById(run.studioAutomation.toString());
      const f = automation?.flow;
      if (!f?.followUpEnabled || !run.linkSentAt) {
        await this.setStep(run._id, { followUpSentAt: now });
        continue;
      }
      const dueAt = new Date(run.linkSentAt.getTime() + (f.followUpDelayMinutes ?? 60) * 60_000);
      if (dueAt > now) continue; // not due yet — leave for a later sweep

      const account = await socialAccountRepository.findWithToken(run.socialAccount.toString());
      if (!account?.accessToken) {
        await this.setStep(run._id, { followUpSentAt: now });
        continue;
      }
      const text = f.followUpMessage || DEFAULT_FOLLOWUP_MSG;
      await this.sendText(account, run, { id: run.participantId }, text);
      await this.setStep(run._id, { followUpSentAt: now });
      sent += 1;
    }
    return { checked: runs.length, sent };
  }
}

export const flowEngineService = new FlowEngineService();
