import axios, { AxiosError, AxiosInstance } from 'axios';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ExternalServiceError } from '../../utils/AppError';
import { InstagramMediaPage, MediaProductType, MediaType, MetaPage, MetaTokenResponse } from './meta.types';

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

  /**
   * Send a private reply that carries call-to-action link buttons, using the
   * Send API button template (used by Automation Studio). Falls back to the
   * plain-text shape when no buttons are provided. Button template text is
   * capped at 640 chars by Meta; callers enforce that at validation time.
   *
   * Docs: https://developers.facebook.com/docs/messenger-platform/send-messages/template/button
   */
  async sendPrivateReplyWithButtons(
    pageId: string,
    commentId: string,
    text: string,
    buttons: Array<{ title: string; url: string }>,
    pageAccessToken: string
  ): Promise<{ id: string }> {
    if (!buttons.length) {
      return this.sendPrivateReply(pageId, commentId, text, pageAccessToken);
    }
    try {
      const { data } = await this.http.post<{ id: string }>(
        `/${pageId}/messages`,
        {
          recipient: { comment_id: commentId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text,
                buttons: buttons.map((b) => ({
                  type: 'web_url',
                  url: b.url,
                  title: b.title,
                })),
              },
            },
          },
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
      this.handleError('sendPrivateReplyWithButtons', error);
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

  /**
   * List an Instagram Business account's media (feed posts AND reels come from
   * the same edge). Cursor-paginated. Reels vs posts are distinguished by the
   * `media_product_type` field (REELS vs FEED); the Graph API does not support
   * filtering that server-side, so callers filter the returned list.
   * Requires the `instagram_basic` scope (already requested at connect time).
   *
   * Docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
   */
  async getMedia(
    igBusinessId: string,
    pageAccessToken: string,
    opts: { limit?: number; after?: string } = {}
  ): Promise<InstagramMediaPage> {
    try {
      const { data } = await this.http.get<{
        data: Array<{
          id: string;
          caption?: string;
          media_type: MediaType;
          media_product_type: MediaProductType;
          media_url?: string;
          thumbnail_url?: string;
          permalink?: string;
          timestamp?: string;
          like_count?: number;
          comments_count?: number;
        }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(`/${igBusinessId}/media`, {
        params: {
          access_token: pageAccessToken,
          appsecret_proof: this.appSecretProof(pageAccessToken),
          fields:
            'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
          limit: opts.limit ?? 25,
          ...(opts.after ? { after: opts.after } : {}),
        },
      });

      return {
        media: (data.data ?? []).map((m) => ({
          id: m.id,
          caption: m.caption,
          mediaType: m.media_type,
          mediaProductType: m.media_product_type,
          mediaUrl: m.media_url,
          thumbnailUrl: m.thumbnail_url,
          permalink: m.permalink,
          timestamp: m.timestamp,
          likeCount: m.like_count,
          commentsCount: m.comments_count,
        })),
        // `next` is only present when another page exists; pair it with the cursor.
        nextCursor: data.paging?.next ? data.paging?.cursors?.after : undefined,
      };
    } catch (error) {
      this.handleError('getMedia', error);
    }
  }

  /**
   * Fetch engagement insights for a single media object (reach, plays, saves…).
   * Valid metrics differ by media type, so callers pass the appropriate set.
   *
   * Docs: https://developers.facebook.com/docs/instagram-api/reference/ig-media/insights
   */
  async getMediaInsights(
    mediaId: string,
    metrics: string[],
    pageAccessToken: string
  ): Promise<Record<string, number>> {
    try {
      const { data } = await this.http.get<{
        data: Array<{ name: string; values: Array<{ value: number }> }>;
      }>(`/${mediaId}/insights`, {
        params: {
          access_token: pageAccessToken,
          appsecret_proof: this.appSecretProof(pageAccessToken),
          metric: metrics.join(','),
        },
      });
      const result: Record<string, number> = {};
      for (const item of data.data ?? []) {
        result[item.name] = item.values?.[0]?.value ?? 0;
      }
      return result;
    } catch (error) {
      this.handleError('getMediaInsights', error);
    }
  }

  /**
   * Fetch a message sender's profile (name/username/avatar) from their
   * IG-scoped or page-scoped ID, for display in the inbox. Best-effort:
   * returns null instead of throwing (profile access can be restricted).
   *
   * Docs: https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile
   */
  async getUserProfile(
    userId: string,
    pageAccessToken: string,
    platform: string
  ): Promise<{ name?: string; username?: string; profilePic?: string } | null> {
    try {
      const fields = platform === 'instagram' ? 'name,username,profile_pic' : 'name,profile_pic';
      const { data } = await this.http.get<{
        name?: string;
        username?: string;
        profile_pic?: string;
      }>(`/${userId}`, {
        params: {
          access_token: pageAccessToken,
          appsecret_proof: this.appSecretProof(pageAccessToken),
          fields,
        },
      });
      return { name: data.name, username: data.username, profilePic: data.profile_pic };
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? (error as AxiosError).response?.data
        : (error as Error)?.message;
      logger.warn('Could not fetch sender profile for inbox display', { userId, detail });
      return null;
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
