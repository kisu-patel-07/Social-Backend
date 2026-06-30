import { Request, Response } from 'express';
import { AutomationStatus, Platform } from '../constants';
import { automationService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

export const automationController = {
  create: asyncHandler(async (req: Request, res: Response) => {
    const automation = await automationService.create(req.user!, req.body);
    sendCreated(res, automation, 'Automation created');
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await automationService.list(req.user!.workspaceId, {
      ...options,
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as AutomationStatus | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const automation = await automationService.getById(req.user!.workspaceId, req.params.id);
    sendSuccess(res, automation);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const automation = await automationService.update(req.user!, req.params.id, req.body);
    sendSuccess(res, automation, 'Automation updated');
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const automation = await automationService.setStatus(req.user!, req.params.id, req.body.status);
    sendSuccess(res, automation, 'Automation status updated');
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await automationService.remove(req.user!, req.params.id);
    sendNoContent(res);
  }),
};
