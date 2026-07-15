import { Schema, model, Document, Types } from 'mongoose';
import { PaymentStatus } from '../constants';

/**
 * A payment attempt against an invoice. The actual gateway integration is a
 * future phase; this records the structure so it can be wired up later.
 */
export interface IPayment extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  invoice?: Types.ObjectId;
  amount: number;
  currency: string;
  status: PaymentStatus;
  /** Gateway identifiers, populated once a provider is integrated. */
  provider?: string;
  providerPaymentId?: string;
  method?: string;
  failureReason?: string;
  paidAt?: Date;
  /** Set when an admin marks the payment refunded (bookkeeping until a gateway exists). */
  refundedAt?: Date;
  refundedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice', index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    status: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.PENDING,
      index: true,
    },
    provider: { type: String },
    providerPaymentId: { type: String, index: true, sparse: true },
    method: { type: String },
    failureReason: { type: String },
    paidAt: { type: Date },
    refundedAt: { type: Date },
    refundedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const PaymentModel = model<IPayment>('Payment', paymentSchema);
