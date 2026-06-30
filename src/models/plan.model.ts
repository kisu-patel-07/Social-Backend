import { Schema, model, Document, Types } from 'mongoose';
import { BillingInterval } from '../constants';

/** A purchasable subscription plan. Seeded by an admin/script. */
export interface IPlan extends Document {
  _id: Types.ObjectId;
  /** Machine code, e.g. "free", "starter", "pro". */
  code: string;
  name: string;
  description?: string;
  /** Price in the smallest currency unit (e.g. cents) to avoid float issues. */
  priceAmount: number;
  currency: string;
  interval: BillingInterval;
  /** Feature limits enforced by the app. -1 means unlimited. */
  limits: {
    connectedAccounts: number;
    automations: number;
    monthlyMessages: number;
    teamMembers: number;
  };
  features: string[];
  isActive: boolean;
  /** Sort order for pricing tables. */
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    priceAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    interval: {
      type: String,
      enum: Object.values(BillingInterval),
      default: BillingInterval.MONTHLY,
    },
    limits: {
      connectedAccounts: { type: Number, default: 1 },
      automations: { type: Number, default: 3 },
      monthlyMessages: { type: Number, default: 500 },
      teamMembers: { type: Number, default: 1 },
    },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const PlanModel = model<IPlan>('Plan', planSchema);
