import { Schema, model, Document, Types } from 'mongoose';

/**
 * One execution of a scheduled job (Vercel cron / npm script), so the admin
 * Health page can show when each job last ran and whether it succeeded — a
 * silently dead cron is otherwise invisible. TTL-expired after 30 days.
 */
export interface IJobRun extends Document {
  _id: Types.ObjectId;
  /** Stable job key, e.g. "refresh-tokens", "flow-followups". */
  job: string;
  ok: boolean;
  /** Small result summary (counts) or the error message on failure. */
  summary?: string;
  durationMs: number;
  createdAt: Date;
  updatedAt: Date;
}

const jobRunSchema = new Schema<IJobRun>(
  {
    job: { type: String, required: true, maxlength: 60, index: true },
    ok: { type: Boolean, required: true },
    summary: { type: String, maxlength: 500 },
    durationMs: { type: Number, required: true },
  },
  { timestamps: true }
);

jobRunSchema.index({ job: 1, createdAt: -1 });
jobRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const JobRunModel = model<IJobRun>('JobRun', jobRunSchema);
