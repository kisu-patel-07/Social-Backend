import { Schema, model, Document, Types } from 'mongoose';
import { ContactMessageStatus } from '../constants';

/**
 * A public contact-form submission, persisted so the admin support inbox can
 * track it to resolution (open -> replied -> closed). Bell notifications are
 * still sent on arrival, but this collection is the source of truth.
 */
export interface IContactMessage extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  adminNote?: string;
  handledBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const contactMessageSchema = new Schema<IContactMessage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    status: {
      type: String,
      enum: Object.values(ContactMessageStatus),
      default: ContactMessageStatus.OPEN,
      index: true,
    },
    adminNote: { type: String, trim: true, maxlength: 2000 },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

contactMessageSchema.index({ status: 1, createdAt: -1 });
contactMessageSchema.index({ email: 1, createdAt: -1 });

export const ContactMessageModel = model<IContactMessage>('ContactMessage', contactMessageSchema);
