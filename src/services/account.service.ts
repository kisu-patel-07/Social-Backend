import { Types } from 'mongoose';
import { ActivityAction, NotificationType, Platform } from '../constants';
import { logger } from '../config/logger';
import { ISocialAccount } from '../models/socialAccount.model';
import { socialAccountRepository, userRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError';
import { signStateToken, verifyStateToken } from '../utils/jwt';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';
import { metaClient, metaService } from './meta';
import { InstagramMedia, InstagramMediaPage } from './meta/meta.types';
import { notificationService } from './notification.service';

interface ConnectAccountParams {
  platform: Platform;
  pageId?: string;
  instagramBusinessId?: string;
  name: string;
  username?: string;
  accessToken: string;
}

class AccountService {
  /**
   * Build the Meta OAuth URL the frontend should redirect the user to.
   * The `state` is a short-lived signed token carrying the initiating user's
   * identity, so the (unauthenticated) callback can attribute the connection.
   */
  getOAuthUrl(user: AuthUser): { url: string; state: string } {
    const state = signStateToken(user.id, user.workspaceId);
    return { url: metaService.buildOAuthUrl(state), state };
  }

  /** Resolve connectable Pages/IG accounts from an OAuth callback code. */
  async resolveConnectable(code: string) {
    return metaService.resolveConnectableAccounts(code);
  }

  /**
   * Handle the Meta OAuth callback end-to-end: verify the signed state to
   * recover the user, exchange the code, and persist every connectable
   * Page / IG account. Tokens never leave the backend. Returns how many were
   * newly connected (duplicates are skipped, not errors).
   */
  async connectFromCallback(
    state: string,
    code: string
  ): Promise<{ connected: number; total: number }> {
    const { userId, workspaceId } = verifyStateToken(state);
    const userDoc = await userRepository.findById(userId);
    if (!userDoc) throw new NotFoundError('User not found');

    const authUser: AuthUser = {
      id: userId,
      workspaceId,
      role: userDoc.role,
      email: userDoc.email,
    };

    const connectable = await metaService.resolveConnectableAccounts(code);
    let connected = 0;

    for (const acc of connectable) {
      try {
        await this.connect(authUser, {
          platform: acc.platform,
          pageId: acc.pageId,
          instagramBusinessId: acc.instagramBusinessId,
          name: acc.name,
          username: acc.username,
          accessToken: acc.pageAccessToken,
        });
        connected += 1;
      } catch (error) {
        // Already-connected accounts (ConflictError) and per-account failures
        // shouldn't abort the whole callback — log and continue.
        logger.warn('Skipped connecting an account during OAuth callback', {
          platform: acc.platform,
          name: acc.name,
          reason: (error as Error).message,
        });
      }
    }

    return { connected, total: connectable.length };
  }

  list(workspaceId: string): Promise<ISocialAccount[]> {
    return socialAccountRepository.listByWorkspace(workspaceId);
  }

  async getById(workspaceId: string, id: string): Promise<ISocialAccount> {
    const account = await socialAccountRepository.findOne({ _id: id, workspace: workspaceId });
    if (!account) throw new NotFoundError('Connected account not found');
    return account;
  }

  /**
   * Fetch an Instagram Business account's posts and/or reels via the Graph API.
   * `type` filters the current page client-side (the API returns both from one
   * edge). When `insights` is set, each item is enriched best-effort with
   * engagement metrics — a per-item failure just omits that item's insights.
   */
  async listMedia(
    workspaceId: string,
    accountId: string,
    opts: { type?: 'posts' | 'reels'; limit?: number; after?: string; insights?: boolean } = {}
  ): Promise<InstagramMediaPage> {
    const account = await this.getById(workspaceId, accountId);
    if (account.platform !== Platform.INSTAGRAM || !account.instagramBusinessId) {
      throw new BadRequestError('Media can only be fetched for Instagram accounts');
    }

    const full = await socialAccountRepository.findWithToken(account.id);
    if (!full?.accessToken) {
      throw new BadRequestError('This account has no valid access token — please reconnect it.');
    }

    const page = await metaClient.getMedia(account.instagramBusinessId, full.accessToken, {
      limit: opts.limit,
      after: opts.after,
    });

    let media = page.media;
    if (opts.type === 'reels') {
      media = media.filter((m) => m.mediaProductType === 'REELS');
    } else if (opts.type === 'posts') {
      media = media.filter((m) => m.mediaProductType === 'FEED');
    }

    if (opts.insights) {
      media = await Promise.all(media.map((m) => this.enrichWithInsights(m, full.accessToken)));
    }

    return { media, nextCursor: page.nextCursor };
  }

  /** Best-effort insights enrichment; returns the media unchanged if it fails. */
  private async enrichWithInsights(
    media: InstagramMedia,
    accessToken: string
  ): Promise<InstagramMedia> {
    // Metric availability differs by media type; request only what applies.
    const metrics =
      media.mediaProductType === 'REELS'
        ? ['plays', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions']
        : ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'];
    try {
      const insights = await metaClient.getMediaInsights(media.id, metrics, accessToken);
      return { ...media, insights };
    } catch (error) {
      logger.warn('Failed to fetch media insights', {
        mediaId: media.id,
        error: (error as Error).message,
      });
      return media;
    }
  }

  /** Persist a selected Page / IG business account and subscribe webhooks. */
  async connect(user: AuthUser, params: ConnectAccountParams): Promise<ISocialAccount> {
    if (params.platform === Platform.INSTAGRAM && !params.instagramBusinessId) {
      throw new BadRequestError('instagramBusinessId is required for Instagram accounts');
    }
    if (!params.pageId && !params.instagramBusinessId) {
      throw new BadRequestError('A pageId or instagramBusinessId is required');
    }

    const duplicate = await socialAccountRepository.findOne({
      workspace: user.workspaceId,
      platform: params.platform,
      isActive: true,
      ...(params.instagramBusinessId
        ? { instagramBusinessId: params.instagramBusinessId }
        : { pageId: params.pageId }),
    });
    if (duplicate) {
      throw new ConflictError('This account is already connected');
    }

    const account = await socialAccountRepository.create({
      workspace: new Types.ObjectId(user.workspaceId),
      platform: params.platform,
      name: params.name,
      username: params.username,
      pageId: params.pageId,
      instagramBusinessId: params.instagramBusinessId,
      accessToken: params.accessToken,
      tokenExpiresAt: metaService.computeTokenExpiry(),
      connectedBy: new Types.ObjectId(user.id),
    });

    // Best-effort webhook subscription; surfaces the real reason as lastError.
    if (params.pageId) {
      await this.trySubscribeWebhook(account.id, params.pageId, params.accessToken);
      const fresh = await socialAccountRepository.findById(account.id);
      if (fresh) account.isWebhookSubscribed = fresh.isWebhookSubscribed;
    }

    await Promise.all([
      analyticsService.refreshWorkspaceStats(user.workspaceId),
      activityService.log({
        workspace: user.workspaceId,
        user: user.id,
        action: ActivityAction.ACCOUNT_CONNECTED,
        description: `Connected ${params.platform} account "${params.name}"`,
        entityType: 'SocialAccount',
        entityId: account._id,
      }),
      notificationService.create({
        workspace: user.workspaceId,
        user: user.id,
        type: NotificationType.ACCOUNT_CONNECTED,
        title: 'Account connected',
        body: `Your ${params.platform} account "${params.name}" is now connected.`,
        link: '/accounts',
      }),
    ]);

    return account;
  }

  /**
   * Attempt to subscribe a page to webhooks, recording success/failure on the
   * account. The real Meta error is stored in `lastError` so it's debuggable
   * from the UI instead of a generic message.
   */
  private async trySubscribeWebhook(
    accountId: string,
    pageId: string,
    accessToken: string
  ): Promise<boolean> {
    try {
      await metaClient.subscribePageWebhooks(pageId, accessToken);
      await socialAccountRepository.updateById(accountId, {
        isWebhookSubscribed: true,
        lastError: undefined,
      });
      return true;
    } catch (error) {
      const detail = (error as { details?: unknown })?.details;
      const reason =
        typeof detail === 'object' && detail
          ? JSON.stringify(detail).slice(0, 280)
          : (error as Error).message;
      logger.warn('Webhook subscription failed', { accountId, pageId, reason });
      await socialAccountRepository.updateById(accountId, {
        isWebhookSubscribed: false,
        lastError: `Webhook subscription failed: ${reason}`,
      });
      return false;
    }
  }

  /** Re-attempt the webhook subscription for an already-connected account. */
  async retryWebhookSubscription(user: AuthUser, id: string): Promise<ISocialAccount> {
    const account = await this.getById(user.workspaceId, id);
    if (!account.pageId) {
      throw new BadRequestError('This account has no linked Page to subscribe.');
    }
    await this.trySubscribeWebhook(account.id, account.pageId, account.accessToken);
    return this.getById(user.workspaceId, id);
  }

  /** Soft-disconnect an account (keeps history, stops processing). */
  async disconnect(user: AuthUser, id: string): Promise<void> {
    const account = await this.getById(user.workspaceId, id);
    await socialAccountRepository.updateById(account.id, {
      isActive: false,
      isWebhookSubscribed: false,
    });
    await Promise.all([
      analyticsService.refreshWorkspaceStats(user.workspaceId),
      activityService.log({
        workspace: user.workspaceId,
        user: user.id,
        action: ActivityAction.ACCOUNT_DISCONNECTED,
        description: `Disconnected ${account.platform} account "${account.name}"`,
        entityType: 'SocialAccount',
        entityId: account._id,
      }),
    ]);
  }
}

export const accountService = new AccountService();
