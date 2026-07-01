import { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { accountService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendSuccess } from '../utils/apiResponse';

/** First configured client origin, used to redirect after the OAuth handshake. */
const clientOrigin = env.CLIENT_URL.split(',')[0];

export const accountController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const accounts = await accountService.list(req.user!.workspaceId);
    sendSuccess(res, accounts);
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const account = await accountService.getById(req.user!.workspaceId, req.params.id);
    sendSuccess(res, account);
  }),

  /** Fetch posts/reels for a connected Instagram account. */
  listMedia: asyncHandler(async (req: Request, res: Response) => {
    const { type, limit, after, insights } = req.query as unknown as {
      type?: 'posts' | 'reels';
      limit?: number;
      after?: string;
      insights?: boolean;
    };
    const result = await accountService.listMedia(req.user!.workspaceId, req.params.id, {
      type,
      limit,
      after,
      insights,
    });
    sendSuccess(res, result, 'Instagram media fetched');
  }),

  /** Return the Meta OAuth URL the frontend should redirect to. */
  startOAuth: asyncHandler(async (req: Request, res: Response) => {
    const { url, state } = accountService.getOAuthUrl(req.user!);
    sendSuccess(res, { url, state }, 'OAuth URL generated');
  }),

  /**
   * OAuth callback (hit directly by Meta's browser redirect — no auth header).
   * Connects the resolved accounts server-side using the signed `state`, then
   * redirects back to the frontend. Always redirects (never returns JSON) so
   * the user lands back in the app, and never exposes access tokens.
   */
  oauthCallback: asyncHandler(async (req: Request, res: Response) => {
    if (req.query.error) {
      return res.redirect(
        `${clientOrigin}/accounts?error=${encodeURIComponent(String(req.query.error))}`
      );
    }

    const code = req.query.code ? String(req.query.code) : '';
    const state = req.query.state ? String(req.query.state) : '';
    if (!code || !state) {
      return res.redirect(`${clientOrigin}/accounts?error=missing_params`);
    }

    try {
      const { connected } = await accountService.connectFromCallback(state, code);
      return res.redirect(`${clientOrigin}/accounts?connected=${connected}`);
    } catch (error) {
      logger.error('OAuth callback failed', { error: (error as Error).message });
      return res.redirect(`${clientOrigin}/accounts?error=connect_failed`);
    }
  }),

  /** Persist a user-selected Page / IG business account. */
  connect: asyncHandler(async (req: Request, res: Response) => {
    const account = await accountService.connect(req.user!, req.body);
    sendCreated(res, account, 'Account connected');
  }),

  /** Re-attempt the webhook subscription for an account that failed it. */
  retryWebhook: asyncHandler(async (req: Request, res: Response) => {
    const account = await accountService.retryWebhookSubscription(req.user!, req.params.id);
    sendSuccess(res, account, 'Webhook subscription retried');
  }),

  disconnect: asyncHandler(async (req: Request, res: Response) => {
    await accountService.disconnect(req.user!, req.params.id);
    sendNoContent(res);
  }),
};
