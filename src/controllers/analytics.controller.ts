import { Request, Response } from 'express';
import { analyticsService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';

export const analyticsController = {
  /** Dashboard summary cards. */
  dashboard: asyncHandler(async (req: Request, res: Response) => {
    const summary = await analyticsService.getDashboardSummary(req.user!.workspaceId);
    sendSuccess(res, summary);
  }),

  /** Analytics page overview with daily series. */
  overview: asyncHandler(async (req: Request, res: Response) => {
    const range = Math.min(Math.max(Number(req.query.range) || 30, 1), 365);
    const overview = await analyticsService.getOverview(req.user!.workspaceId, range);
    sendSuccess(res, overview);
  }),

  /** Per-automation funnel: triggered -> DM sent -> clicked -> leads. */
  funnels: asyncHandler(async (req: Request, res: Response) => {
    const range = Math.min(Math.max(Number(req.query.range) || 30, 1), 365);
    const funnels = await analyticsService.getAutomationFunnels(req.user!.workspaceId, range);
    sendSuccess(res, funnels);
  }),
};
