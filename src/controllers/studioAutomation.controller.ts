import { Request, Response } from 'express';
import { Platform, StudioAutomationStatus } from '../constants';
import { studioAutomationService } from '../services/studioAutomation.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

export const studioAutomationController = {
  create: asyncHandler(async (req: Request, res: Response) => {
    const automation = await studioAutomationService.create(req.user!, req.body);
    sendCreated(res, automation, 'Studio automation created');
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await studioAutomationService.list(req.user!.workspaceId, {
      ...options,
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as StudioAutomationStatus | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const automation = await studioAutomationService.getById(req.user!.workspaceId, req.params.id);
    sendSuccess(res, automation);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const automation = await studioAutomationService.update(req.user!, req.params.id, req.body);
    sendSuccess(res, automation, 'Studio automation updated');
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const automation = await studioAutomationService.setStatus(
      req.user!,
      req.params.id,
      req.body.status
    );
    sendSuccess(res, automation, 'Studio automation status updated');
  }),

  duplicate: asyncHandler(async (req: Request, res: Response) => {
    const automation = await studioAutomationService.duplicate(req.user!, req.params.id);
    sendCreated(res, automation, 'Studio automation duplicated');
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await studioAutomationService.remove(req.user!, req.params.id);
    sendNoContent(res);
  }),
};
