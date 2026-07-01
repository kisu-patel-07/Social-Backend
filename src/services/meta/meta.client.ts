import axios, { AxiosError, AxiosInstance } from 'axios';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ExternalServiceError } from '../../utils/AppError';
import { MetaPage, MetaTokenResponse } from './meta.types';

/**
 * Low-level client for the Meta Graph API (Facebook + Instagram).
 *
 * NOTE: Credentials are stubbed for local development. Each method follows the
 * documented Graph API contract (v21.0) so plugging in real credentials in
 * `.env` makes these calls live without code changes.
 *
 * Docs:
 *  - OAuth: https://developers.facebook.com/docs/facebook-login/guides/access-tokens
 *  - Pages/IG: https://developers.facebook.com/docs/instagram-api/getting-started
 *  - Comment moderation: https://developers.facebook.com/docs/graph-api/reference/comment
 *  - Private replies: https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
 *  - Send API: https://developers.facebook.com/docs/messenger-platform/reference/send-api
 */
class MetaClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_VERSION}`,
      timeout: 20000,
    });
  }

  /** appsecret_proof guards server-to-server calls (recommended by Meta). */
  private appSecretProof(accessToken: string): string {
    return crypto.createHmac('sha256', env.META_APP_SECRET).update(accessToken).digest('hex');
  }

  private handleError(context: string, error: unknown): never {
    const detail = axios.isAxiosError(error)
      ? (error as AxiosError).response?.data
      : (error as Error)?.message;
    logger.error(`Meta API error: ${context}`, { detail });
    throw new ExternalServiceError(`Meta API request failed: ${context}`, detail);
  }

  /** Build the OAuth dialog URL the user is redirected to. */
  buildOAuthUrl(state: string, scopes: string[]): string {
    const params = new URLSearchParams({
      client_id: env.META_APP_ID,
      redirect_uri: env.META_OAUTH_REDIRECT_URI,
      state,
      response_type: 'code',
      scope: scopes.join(','),
    });
    return `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
  }

  /** Exchange an OAuth `code` for a short-lived user access token. */
  async exchangeCodeForToken(code: string): Promise<MetaTokenResponse> {
    try {
      const { data } = await this.http.get<MetaTokenResponse>('/oauth/access_token', {
        params: {
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          redirect_uri: env.META_OAUTH_REDIRECT_URI,
          code,
        },
      });
      return data;
    } catch (error) {
      this.handleError('exchangeCodeForToken', error);
    }
  }

  /** Upgrade a short-lived token to a long-lived (~60 day) token. */
  async getLongLivedToken(shortLivedToken: string): Promise<MetaTokenResponse> {
    try {
      const { data } = await this.http.get<MetaTokenResponse>('/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: shortLivedToken,
        },
      });
      return data;
    } catch (error) {
      this.handleError('getLongLivedToken', error);
    }
  }

  /** List the Pages the user manages, including linked IG business accounts. */
  async getUserPages(userAccessToken: string): Promise<MetaPage[]> {
    try {
      const { data } = await this.http.get<{ data: MetaPage[] }>('/me/accounts', {
        params: {
          access_token: userAccessToken,
          appsecret_proof: this.appSecretProof(userAccessToken),
          fields: 'id,name,access_token,category,tasks,instagram_business_account{id,username}',
        },
      });
      return data.data ?? [];
    } catch (error) {
      this.handleError('getUserPages', error);
    }
  }

  /**
   * Subscribe a Page to webhook fields so events are delivered to our app.
   * Only valid Page-object field names are allowed here: FB post comments are
   * covered by `feed`; Instagram comment events are delivered via the app-level
   * Instagram webhook subscription configured in the Meta dashboard.
   */
  async subscribePageWebhooks(pageId: string, pageAccessToken: string): Promise<void> {
    try {
      await this.http.post(`/${pageId}/subscribed_apps`, null, {
        params: {
          access_token: pageAccessToken,
          appsecret_proof: this.appSecretProof(pageAccessToken),
          subscribed_fields: 'feed,mention,messages,messaging_postbacks',
        },
      });
    } catch (error) {
      this.handleError('subscribePageWebhooks', error);
    }
  }

  /** Post a public reply to a comment (FB or IG). */
  async replyToComment(
    commentId: string,
    message: string,
    pageAccessToken: string
  ): Promise<{ id: string }> {
    try {
      const { data } = await this.http.post<{ id: string }>(`/${commentId}/replies`, null, {
        params: {
          message,
          access_token: pageAccessToken,
          appsecret_proof: this.appSecretProof(pageAccessToken),
        },
      });
      return data;
    } catch (error) {
      this.handleError('replyToComment', error);
    }
  }

  /**
   * Send a private reply to a comment (turns a public comment into a DM).
   * This is the supported path for comment-to-DM on both IG and Messenger.
   */
  async sendPrivateReply(
    pageId: string,
    commentId: string,
    message: string,
    pageAccessToken: string
  ): Promise<{ id: string }> {
    try {
      const { data } = await this.http.post<{ id: string }>(
        `/${pageId}/messages`,
        {
          recipient: { comment_id: commentId },
          message: { text: message },
        },
        {
          params: {
            access_token: pageAccessToken,
            appsecret_proof: this.appSecretProof(pageAccessToken),
          },
        }
      );
      return data;
    } catch (error) {
      this.handleError('sendPrivateReply', error);
    }
  }

  /** Send a direct message to a user via the Send API (manual inbox replies). */
  async sendDirectMessage(
    pageId: string,
    recipientId: string,
    message: string,
    pageAccessToken: string
  ): Promise<{ message_id?: string }> {
    try {
      const { data } = await this.http.post<{ message_id?: string }>(
        `/${pageId}/messages`,
        {
          recipient: { id: recipientId },
          messaging_type: 'RESPONSE',
          message: { text: message },
        },
        {
          params: {
            access_token: pageAccessToken,
            appsecret_proof: this.appSecretProof(pageAccessToken),
          },
        }
      );
      return data;
    } catch (error) {
      this.handleError('sendDirectMessage', error);
    }
  }

  /** Inspect a token's validity and expiry (used by the refresh job). */
  async debugToken(
    inputToken: string
  ): Promise<{ is_valid: boolean; expires_at: number; scopes: string[] }> {
    try {
      const appToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;
      const { data } = await this.http.get<{
        data: { is_valid: boolean; expires_at: number; scopes: string[] };
      }>('/debug_token', {
        params: { input_token: inputToken, access_token: appToken },
      });
      return data.data;
    } catch (error) {
      this.handleError('debugToken', error);
    }
  }
}

export const metaClient = new MetaClient();
