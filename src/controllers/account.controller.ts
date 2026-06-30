import { Request, Response } from 'express';
import { env } from '../config/env';
import { accountService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendSuccess } from '../utils/apiResponse';

export const accountController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const accounts = await accountService.list(req.user!.workspaceId);
    sendSuccess(res, accounts);
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const account = await accountService.getById(req.user!.workspaceId, req.params.id);
    sendSuccess(res, account);
  }),

  /** Return the Meta OAuth URL the frontend should redirect to. */
  startOAuth: asyncHandler(async (_req: Request, res: Response) => {
    const { url, state } = accountService.getOAuthUrl();
    sendSuccess(res, { url, state }, 'OAuth URL generated');
  }),

  /**
   * OAuth callback. Resolves the user's connectable Pages/IG accounts and
   * returns them so the frontend can let the user choose which to connect.
   */
  oauthCallback: asyncHandler(async (req: Request, res: Response) => {
    if (req.query.error) {
      res.redirect(`${env.CLIENT_URL.split(',')[0]}/accounts?error=${req.query.error}`);
      return;
    }
    const code = String(req.query.code);
    const connectable = await accountService.resolveConnectable(code);
    sendSuccess(res, { accounts: connectable }, 'Resolved connectable accounts');
  }),

  /** Persist a user-selected Page / IG business account. */
  connect: asyncHandler(async (req: Request, res: Response) => {
    const account = await accountService.connect(req.user!, req.body);
    sendCreated(res, account, 'Account connected');
  }),

  disconnect: asyncHandler(async (req: Request, res: Response) => {
    await accountService.disconnect(req.user!, req.params.id);
    sendNoContent(res);
  }),
};
