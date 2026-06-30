import { Schema, model, Document, Types } from 'mongoose';
import { Platform } from '../constants';

/**
 * Pre-aggregated daily analytics counters per workspace (and optionally per
 * platform). Incremented as events happen so dashboard/graph queries are cheap
 * without needing Redis or a separate analytics store.
 */
export interface IAnalyticsDaily extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  /** YYYY-MM-DD bucket (local to workspace timezone). */
  dateKey: string;
  date: Date;
  platform?: Platform;
  commentsTriggered: number;
  dmSent: number;
  newLeads: number;
  messagesReceived: number;
  createdAt: Date;
  updatedAt: Date;
}

const analyticsDailySchema = new Schema<IAnalyticsDaily>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    dateKey: { type: String, required: true },
    date: { type: Date, required: true },
    platform: { type: String, enum: Object.values(Platform) },
    commentsTriggered: { type: Number, default: 0 },
    dmSent: { type: Number, default: 0 },
    newLeads: { type: Number, default: 0 },
    messagesReceived: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One bucket per workspace+date+platform.
analyticsDailySchema.index({ workspace: 1, dateKey: 1, platform: 1 }, { unique: true });
analyticsDailySchema.index({ workspace: 1, date: -1 });

export const AnalyticsDailyModel = model<IAnalyticsDaily>('Analytics', analyticsDailySchema);
