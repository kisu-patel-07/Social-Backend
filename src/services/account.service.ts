import { Types } from 'mongoose';
import { ActivityAction, NotificationType, Platform } from '../constants';
import { ISocialAccount } from '../models/socialAccount.model';
import { socialAccountRepository } from '../repositories';
import { AuthUser } from '../types/auth.types';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError';
import { generateRandomToken } from '../utils/password';
import { activityService } from './activity.service';
import { analyticsService } from './analytics.service';
import { metaClient, metaService } from './meta';
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
  /** Build the Meta OAuth URL the frontend should redirect the user to. */
  getOAuthUrl(): { url: string; state: string } {
    const state = generateRandomToken(16);
    return { url: metaService.buildOAuthUrl(state), state };
  }

  /** Resolve connectable Pages/IG accounts from an OAuth callback code. */
  async resolveConnectable(code: string) {
    return metaService.resolveConnectableAccounts(code);
  }

  list(workspaceId: string): Promise<ISocialAccount[]> {
    return socialAccountRepository.listByWorkspace(workspaceId);
  }

  async getById(workspaceId: string, id: string): Promise<ISocialAccount> {
    const account = await socialAccountRepository.findOne({ _id: id, workspace: workspaceId });
    if (!account) throw new NotFoundError('Connected account not found');
    return account;
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

    // Best-effort webhook subscription; surfaces as lastError if it fails.
    if (params.pageId) {
      try {
        await metaClient.subscribePageWebhooks(params.pageId, params.accessToken);
        await socialAccountRepository.updateById(account.id, { isWebhookSubscribed: true });
        account.isWebhookSubscribed = true;
      } catch {
        await socialAccountRepository.updateById(account.id, {
          lastError: 'Webhook subscription failed — automations may not trigger.',
        });
      }
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
