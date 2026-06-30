import { INotification, NotificationModel } from '../models/notification.model';
import { BaseRepository } from './base.repository';

class NotificationRepository extends BaseRepository<INotification> {
  constructor() {
    super(NotificationModel);
  }

  countUnread(userId: string): Promise<number> {
    return this.count({ user: userId, isRead: false });
  }

  markAllRead(userId: string): Promise<number> {
    return this.model
      .updateMany({ user: userId, isRead: false }, { $set: { isRead: true, readAt: new Date() } })
      .exec()
      .then((res) => res.modifiedCount ?? 0);
  }
}

export const notificationRepository = new NotificationRepository();
