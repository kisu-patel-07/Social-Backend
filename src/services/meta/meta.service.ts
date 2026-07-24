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

    // TEMP DIAGNOSTIC: reveal exactly what Meta returned so we can see whether an
    // Instagram Business account is attached to each Page, and which scopes the
    // user actually granted at consent. Remove once the IG-connect issue is resolved.
    try {
      const tokenInfo = await metaClient.debugToken(longLived.access_token);
      logger.info('[META DIAG] granted scopes', { scopes: tokenInfo.scopes });
    } catch (error) {
      logger.warn('[META DIAG] could not inspect token scopes', {
        error: (error as Error).message,
      });
    }
    logger.info('[META DIAG] pages returned by /me/accounts', {
      count: pages.length,
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        hasInstagram: Boolean(p.instagram_business_account?.id),
        instagramBusinessId: p.instagram_business_account?.id,
        instagramUsername: p.instagram_business_account?.username,
      })),
    });

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
   * Validate stored tokens that our records say are nearing expiry, and record
   * their real state. Intended to be invoked by a scheduled job (cron).
   *
   * Note on the token model: we store Page access tokens derived from a
   * long-lived user token, and those generally DO NOT expire (debug_token
   * reports expires_at = 0). So this job cannot "refresh" a Page token by
   * re-exchanging it — fb_exchange_token requires a *user* token and would fail
   * on every account. Instead it inspects each token with debug_token and:
   *  - clears the stale `tokenExpiresAt` countdown to the real expiry (or a
   *    fresh horizon for non-expiring tokens), so healthy accounts stop
   *    re-entering this window every night;
   *  - flags genuinely invalid/revoked tokens with `lastError` so the UI can
   *    prompt the user to reconnect.
   */
  async refreshExpiringTokens(): Promise<{ checked: number; healthy: number; invalid: number }> {
    const threshold = addDays(new Date(), TOKEN_REFRESH_THRESHOLD_DAYS);
    const accounts = await socialAccountRepository.findExpiringTokens(threshold);
    let healthy = 0;
    let invalid = 0;

    for (const account of accounts) {
      try {
        const info = await metaClient.debugToken(account.accessToken);
        if (!info.is_valid) {
          invalid += 1;
          await socialAccountRepository.updateById(account.id, {
            $set: { lastError: 'Connection expired — please reconnect this account.' },
          });
          continue;
        }
        // expires_at = 0 means the Page token does not expire (normal for
        // tokens derived from a long-lived user token). Record the real expiry
        // (or a fresh horizon) and clear any stale error via $unset — a plain
        // `lastError: undefined` is stripped by Mongoose and never clears it.
        const tokenExpiresAt =
          info.expires_at > 0 ? new Date(info.expires_at * 1000) : this.computeTokenExpiry();
        await socialAccountRepository.updateById(account.id, {
          $set: { tokenExpiresAt },
          $unset: { lastError: '' },
        });
        healthy += 1;
      } catch (error) {
        logger.warn('Token check failed for account', {
          accountId: account.id,
          error: (error as Error).message,
        });
        await socialAccountRepository.updateById(account.id, {
          $set: { lastError: 'Token refresh failed — please reconnect this account.' },
        });
      }
    }

    return { checked: accounts.length, healthy, invalid };
  }
}

export const metaService = new MetaService();
