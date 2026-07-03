import { Request, Response } from 'express';
import { ConversationStatus, Platform } from '../constants';
import { inboxService } from '../services';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendPaginated, sendSuccess } from '../utils/apiResponse';
import { buildPaginationOptions } from '../utils/pagination';

export const inboxController = {
  listConversations: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query, 'lastMessageAt');
    const result = await inboxService.list(req.user!.workspaceId, {
      ...options,
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as ConversationStatus | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  listComments: asyncHandler(async (req: Request, res: Response) => {
    const options = buildPaginationOptions(req.query, 'createdAt');
    const result = await inboxService.listComments(req.user!.workspaceId, {
      ...options,
      platform: req.query.platform as Platform | undefined,
      socialAccountId: req.query.socialAccountId as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendPaginated(res, result.items, result.meta);
  }),

  getThread: asyncHandler(async (req: Request, res: Response) => {
    const thread = await inboxService.getThread(req.user!.workspaceId, req.params.id);
    sendSuccess(res, thread);
  }),

  setStatus: asyncHandler(async (req: Request, res: Response) => {
    const conversation = await inboxService.setStatus(
      req.user!.workspaceId,
      req.params.id,
      req.body.status
    );
    sendSuccess(res, conversation, 'Conversation updated');
  }),

  reply: asyncHandler(async (req: Request, res: Response) => {
    const message = await inboxService.reply(req.user!, req.params.id, req.body.text);
    sendCreated(res, message, 'Reply sent');
  }),

  unreadCount: asyncHandler(async (req: Request, res: Response) => {
    const count = await inboxService.countUnread(req.user!.workspaceId);
    sendSuccess(res, { count });
  }),
};
