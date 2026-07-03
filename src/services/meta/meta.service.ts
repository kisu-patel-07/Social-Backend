import { Platform, TOKEN_REFRESH_THRESHOLD_DAYS } from '../../constants';
import { logger } from '../../config/logger';
import { socialAccountRepository } from '../../repositories';
import { addDays } from '../../utils/date';
import { metaClient } from './meta.client';
import { ConnectableAccount } from './meta.types';

/**
 * Orchestrates Meta-specific account lifecycle: resolving connectable entities
 * after OAuth, and refreshing long-lived tokens before they expire.
 */
class MetaService {
  /** OAuth scopes required for comment-to-DM automation. */
  readonly scopes = [
    'pages_show_list',
    'pages_manage_metadata',
    'pages_manage_engagement',
    'pages_messaging',
    'pages_read_engagement',
    'pages_read_user_content',
    'instagram_basic',
    'instagram_manage_comments',
    'instagram_manage_messages',
    'business_management',
  ];

  buildOAuthUrl(state: string): string {
    return metaClient.buildOAuthUrl(state, this.scopes);
  }

  /**
   * Given an OAuth code, resolve the list of Pages / IG business accounts the
   * user can connect, each with a long-lived page access token.
   */
  async resolveConnectableAccounts(code: string): Promise<ConnectableAccount[]> {
    const shortLived = await metaClient.exchangeCodeForToken(code);
    const longLived = await metaClient.getLongLivedToken(shortLived.access_token);
    const pages = await metaClient.getUserPages(longLived.access_token);

    const accounts: ConnectableAccount[] = [];
    for (const page of pages) {
      // Facebook Page entity.
      accounts.push({
        platform: Platform.FACEBOOK,
        pageId: page.id,
        name: page.name,
        pageAccessToken: page.access_token,
      });

      // Linked Instagram Business account, if any.
      if (page.instagram_business_account?.id) {
        accounts.push({
          platform: Platform.INSTAGRAM,
          pageId: page.id,
          instagramBusinessId: page.instagram_business_account.id,
          name: page.instagram_business_account.username || page.name,
          username: page.instagram_business_account.username,
          pageAccessToken: page.access_token,
        });
      }
    }
    return accounts;
  }

  /** Long-lived tokens last ~60 days; persist a conservative expiry. */
  computeTokenExpiry(): Date {
    return addDays(new Date(), 60);
  }

  /**
   * Refresh tokens that are within the refresh threshold of expiring.
   * Intended to be invoked by a scheduled job (cron) — implemented without
   * Redis/queues per the MVP constraints.
   */
  async refreshExpiringTokens(): Promise<{ checked: number; refreshed: number }> {
    const threshold = addDays(new Date(), TOKEN_REFRESH_THRESHOLD_DAYS);
    const accounts = await socialAccountRepository.findExpiringTokens(threshold);
    let refreshed = 0;

    for (const account of accounts) {
      try {
        const longLived = await metaClient.getLongLivedToken(account.accessToken);
        await socialAccountRepository.updateById(account.id, {
          accessToken: longLived.access_token,
          tokenExpiresAt: this.computeTokenExpiry(),
          lastError: undefined,
        });
        refreshed += 1;
      } catch (error) {
        logger.warn('Token refresh failed for account', {
          accountId: account.id,
          error: (error as Error).message,
        });
        await socialAccountRepository.updateById(account.id, {
          lastError: 'Token refresh failed — please reconnect this account.',
        });
      }
    }

    return { checked: accounts.length, refreshed };
  }
}

export const metaService = new MetaService();
