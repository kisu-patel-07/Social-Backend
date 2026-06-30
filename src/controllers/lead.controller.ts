import { Request, Response } from 'express';
import { LeadStatus, Platform } from '../constants';
import { leadService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendNoContent, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';
import { toDateKey } from '../utils/date';

export const leadController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await leadService.list(req.user!.workspaceId, {
      ...options,
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as LeadStatus | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      tag: req.query.tag as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  getById: asyncHandler(async (req: Request, res: Response) => {
    const lead = await leadService.getById(req.user!.workspaceId, req.params.id);
    sendSuccess(res, lead);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    const lead = await leadService.update(req.user!, req.params.id, req.body);
    sendSuccess(res, lead, 'Lead updated');
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await leadService.remove(req.user!.workspaceId, req.params.id);
    sendNoContent(res);
  }),

  exportCsv: asyncHandler(async (req: Request, res: Response) => {
    const csv = await leadService.exportCsv(req.user!.workspaceId, {
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as LeadStatus | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      search: req.query.search as string | undefined,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leads-${toDateKey(new Date())}.csv"`
    );
    res.status(200).send(csv);
  }),
};
