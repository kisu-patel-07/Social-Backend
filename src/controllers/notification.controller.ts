import { Request, Response } from 'express';
import { notificationService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

export const notificationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query);
    const result = await notificationService.list(req.user!.id, options);
    sendPaginated(res, result.items, result.meta);
  }),

  unreadCount: asyncHandler(async (req: Request, res: Response) => {
    const count = await notificationService.countUnread(req.user!.id);
    sendSuccess(res, { count });
  }),

  markRead: asyncHandler(async (req: Request, res: Response) => {
    const notification = await notificationService.markRead(req.user!.id, req.params.id);
    sendSuccess(res, notification, 'Notification marked read');
  }),

  markAllRead: asyncHandler(async (req: Request, res: Response) => {
    const modified = await notificationService.markAllRead(req.user!.id);
    sendSuccess(res, { modified }, 'All notifications marked read');
  }),
};
