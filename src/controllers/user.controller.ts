import { Request, Response } from 'express';
import { featureService, settingsService, subscriptionService } from '../services';
import { adminService } from '../services/admin.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const userController = {
  /** Return the authenticated user, their workspace, subscription and feature flags. */
  me: asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const [profile, workspace, subscription, features, banner] = await Promise.all([
      settingsService.getProfile(user.id),
      settingsService.getWorkspace(user.workspaceId),
      subscriptionService.getCurrent(user.workspaceId),
      featureService.flagsForWorkspace(user.workspaceId),
      adminService.getBanner(),
    ]);
    sendSuccess(res, {
      user: profile,
      workspace,
      subscription,
      features,
      // The operator-controlled maintenance banner (null when disabled).
      banner: banner.enabled ? banner : null,
      // Lets the client show the "viewing as" banner after a hard refresh.
      impersonation: user.isImpersonation === true,
    });
  }),
};
