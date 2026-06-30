import { Schema, model, Document, Types } from 'mongoose';
import { InvoiceStatus } from '../constants';

/** A billing invoice for a workspace's subscription period. */
export interface IInvoice extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  subscription?: Types.ObjectId;
  /** Human-friendly sequential invoice number. */
  number: string;
  status: InvoiceStatus;
  /** Amounts in smallest currency unit. */
  amountDue: number;
  amountPaid: number;
  currency: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
  periodStart?: Date;
  periodEnd?: Date;
  dueDate?: Date;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceSchema = new Schema<IInvoice>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    number: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: Object.values(InvoiceStatus),
      default: InvoiceStatus.DRAFT,
      index: true,
    },
    amountDue: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    lineItems: {
      type: [
        {
          description: { type: String, required: true },
          quantity: { type: Number, default: 1 },
          unitAmount: { type: Number, required: true },
        },
      ],
      default: [],
    },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    dueDate: { type: Date },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export const InvoiceModel = model<IInvoice>('Invoice', invoiceSchema);
