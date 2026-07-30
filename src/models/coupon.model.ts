import { Schema, model, Document, Types } from 'mongoose';
import { CouponType } from '../constants';

/**
 * A discount code redeemable at checkout. Discounts are ONE-TIME by design:
 * they apply to the first payment only and never to a renewal, so a coupon
 * checkout always goes through the one-time payment path (never an
 * auto-debit mandate, which Razorpay cannot discount for a single cycle).
 */
export interface ICoupon extends Document {
  _id: Types.ObjectId;
  /** Uppercase, unique — what the customer types. */
  code: string;
  /** Internal note shown in the admin list (not to customers). */
  description?: string;
  type: CouponType;
  /** PERCENT: 1–100. FLAT: amount off in the smallest currency unit. */
  value: number;
  /** FLAT only — the currency the amount is expressed in (must match the plan). */
  currency?: string;
  /** Total redemptions allowed across all customers; absent = unlimited. */
  maxRedemptions?: number;
  /** Incremented on every successful redemption. */
  redemptionCount: number;
  /** Restrict to specific plans; empty = every paid plan. */
  plans: Types.ObjectId[];
  expiresAt?: Date;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, trim: true },
    type: { type: String, enum: Object.values(CouponType), required: true },
    value: { type: Number, required: true, min: 1 },
    currency: { type: String, uppercase: true },
    maxRedemptions: { type: Number, min: 1 },
    redemptionCount: { type: Number, default: 0, min: 0 },
    plans: [{ type: Schema.Types.ObjectId, ref: 'Plan' }],
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const CouponModel = model<ICoupon>('Coupon', couponSchema);

/**
 * One workspace's use of one coupon. The unique (coupon, workspace) index is
 * what actually enforces "one time per customer" — checking a count first
 * would race two simultaneous checkouts.
 */
export interface ICouponRedemption extends Document {
  _id: Types.ObjectId;
  coupon: Types.ObjectId;
  workspace: Types.ObjectId;
  plan: Types.ObjectId;
  payment?: Types.ObjectId;
  /** How much was taken off, in the smallest currency unit. */
  amountDiscounted: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const couponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    amountDiscounted: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true },
  },
  { timestamps: true }
);

couponRedemptionSchema.index({ coupon: 1, workspace: 1 }, { unique: true });

export const CouponRedemptionModel = model<ICouponRedemption>(
  'CouponRedemption',
  couponRedemptionSchema
);
