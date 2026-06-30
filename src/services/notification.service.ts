import { Types } from 'mongoose';
import { NotificationType } from '../constants';
import { INotification } from '../models/notification.model';
import { notificationRepository } from '../repositories';
import { PaginatedResult, PaginationOptions } from '../types/common.types';

interface CreateNotificationParams {
  workspace: string;
  user: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

/** Manages in-app notifications (the bell menu). Email is handled separately. */
class NotificationService {
  create(params: CreateNotificationParams): Promise<INotification> {
    return notificationRepository.create({
      workspace: new Types.ObjectId(params.workspace),
      user: new Types.ObjectId(params.user),
      type: params.type,
      title: params.title,
      body: params.body,
      link: params.link,
      metadata: params.metadata,
    });
  }

  list(userId: string, options: PaginationOptions): Promise<PaginatedResult<INotification>> {
    return notificationRepository.paginate({ user: userId }, options);
  }

  countUnread(userId: string): Promise<number> {
    return notificationRepository.countUnread(userId);
  }

  markRead(userId: string, id: string): Promise<INotification | null> {
    return notificationRepository.updateOne(
      { _id: id, user: userId },
      { $set: { isRead: true, readAt: new Date() } }
    );
  }

  markAllRead(userId: string): Promise<number> {
    return notificationRepository.markAllRead(userId);
  }
}

export const notificationService = new NotificationService();
