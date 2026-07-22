import { Schema, model, Document, Types } from 'mongoose';
import { DemoRequestStatus, DemoRequestTopic } from '../constants';

/**
 * A public "book a demo" enquiry: anyone (no account needed) can request a
 * live demo call or help setting their account up. Managed from the admin
 * panel (pending -> scheduled -> completed / cancelled).
 */
export interface IDemoRequest extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  /** Phone / WhatsApp number for the call. */
  phone?: string;
  topic: DemoRequestTopic;
  /** Visitor's preferred day (YYYY-MM-DD) and time-slot label, verbatim. */
  preferredDate?: string;
  preferredSlot?: string;
  message?: string;
  status: DemoRequestStatus;
  /** Confirmed call time, set by the admin when scheduling. */
  scheduledAt?: Date;
  adminNote?: string;
  handledBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const demoRequestSchema = new Schema<IDemoRequest>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30 },
    topic: {
      type: String,
      enum: Object.values(DemoRequestTopic),
      default: DemoRequestTopic.DEMO,
    },
    preferredDate: { type: String, trim: true, maxlength: 10 },
    preferredSlot: { type: String, trim: true, maxlength: 60 },
    message: { type: String, trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: Object.values(DemoRequestStatus),
      default: DemoRequestStatus.PENDING,
      index: true,
    },
    scheduledAt: { type: Date },
    adminNote: { type: String, trim: true, maxlength: 2000 },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

demoRequestSchema.index({ status: 1, createdAt: -1 });
demoRequestSchema.index({ email: 1, createdAt: -1 });

export const DemoRequestModel = model<IDemoRequest>('DemoRequest', demoRequestSchema);
