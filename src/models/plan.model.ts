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
  /** Validity length in days when interval is DAYS (day-wise packs). */
  durationDays?: number;
  /** Feature limits enforced by the app. -1 means unlimited. */
  limits: {
    connectedAccounts: number;
    automations: number;
    monthlyMessages: number;
    teamMembers: number;
  };
  /** On/off features included in this plan, enforced server-side. */
  entitlements: {
    studio: boolean;
    csvExport: boolean;
  };
  /** Marketing bullet points shown on the pricing card. */
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
    durationDays: { type: Number, min: 1, max: 365 },
    limits: {
      connectedAccounts: { type: Number, default: 1 },
      automations: { type: Number, default: 3 },
      monthlyMessages: { type: Number, default: 500 },
      teamMembers: { type: Number, default: 1 },
    },
    entitlements: {
      // Default true so plans created before entitlements existed stay unrestricted.
      studio: { type: Boolean, default: true },
      csvExport: { type: Boolean, default: true },
    },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const PlanModel = model<IPlan>('Plan', planSchema);
