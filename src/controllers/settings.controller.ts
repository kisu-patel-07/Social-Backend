import { Request, Response } from 'express';
import { settingsService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { clearRefreshCookie } from '../utils/cookies';
import { sendNoContent, sendSuccess } from '../utils/apiResponse';

export const settingsController = {
  getProfile: asyncHandler(async (req: Request, res: Response) => {
    const profile = await settingsService.getProfile(req.user!.id);
    sendSuccess(res, profile);
  }),

  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const profile = await settingsService.updateProfile(req.user!.id, req.body);
    sendSuccess(res, profile, 'Profile updated');
  }),

  getWorkspace: asyncHandler(async (req: Request, res: Response) => {
    const workspace = await settingsService.getWorkspace(req.user!.workspaceId);
    sendSuccess(res, workspace);
  }),

  updateWorkspace: asyncHandler(async (req: Request, res: Response) => {
    const workspace = await settingsService.updateWorkspace(req.user!.workspaceId, req.body);
    sendSuccess(res, workspace, 'Workspace updated');
  }),

  updateNotificationPrefs: asyncHandler(async (req: Request, res: Response) => {
    const profile = await settingsService.updateNotificationPrefs(req.user!.id, req.body);
    sendSuccess(res, profile, 'Notification preferences updated');
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    await settingsService.changePassword(
      req.user!.id,
      req.body.currentPassword,
      req.body.newPassword
    );
    sendSuccess(res, null, 'Password changed');
  }),

  deleteAccount: asyncHandler(async (req: Request, res: Response) => {
    await settingsService.deleteAccount(req.user!, req.body.password);
    clearRefreshCookie(res);
    sendNoContent(res);
  }),
};
