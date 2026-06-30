import { Request, Response } from 'express';
import { settingsService, subscriptionService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const userController = {
  /** Return the authenticated user, their workspace, and current subscription. */
  me: asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const [profile, workspace, subscription] = await Promise.all([
      settingsService.getProfile(user.id),
      settingsService.getWorkspace(user.workspaceId),
      subscriptionService.getCurrent(user.workspaceId),
    ]);
    sendSuccess(res, { user: profile, workspace, subscription });
  }),
};
