import { Schema, model, Document, Types } from 'mongoose';
import { NotificationType } from '../constants';

export interface INotification extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  /** Recipient user (notifications are per-user within a workspace). */
  user: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  /** Optional deep-link path within the app, e.g. /leads/:id. */
  link?: string;
  /** Arbitrary structured payload for rendering. */
  metadata?: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    link: { type: String },
    metadata: { type: Schema.Types.Mixed },
    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

export const NotificationModel = model<INotification>('Notification', notificationSchema);
