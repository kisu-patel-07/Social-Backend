import { Schema, model, Document, Types } from 'mongoose';
import { SubscriptionStatus } from '../constants';

/** A workspace's current subscription to a plan. */
export interface ISubscription extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  plan: Types.ObjectId;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt?: Date;
  /** When the "trial ending soon" reminder was sent (dedupe for the cron job). */
  trialEndingNotifiedAt?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  /** Placeholder for a future gateway customer/subscription reference. */
  externalCustomerId?: string;
  externalSubscriptionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    workspace: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      unique: true,
      index: true,
    },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    status: {
      type: String,
      enum: Object.values(SubscriptionStatus),
      default: SubscriptionStatus.TRIALING,
      index: true,
    },
    currentPeriodStart: { type: Date, default: () => new Date() },
    currentPeriodEnd: { type: Date, required: true },
    trialEndsAt: { type: Date },
    trialEndingNotifiedAt: { type: Date },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: { type: Date },
    externalCustomerId: { type: String },
    externalSubscriptionId: { type: String },
  },
  { timestamps: true }
);

export const SubscriptionModel = model<ISubscription>('Subscription', subscriptionSchema);
