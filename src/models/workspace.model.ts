import { Schema, model, Document, Types } from 'mongoose';

export interface IWorkspace extends Document {
  _id: Types.ObjectId;
  name: string;
  /** Owning user. Multi-member workspaces are a future phase. */
  owner: Types.ObjectId;
  timezone: string;
  /** Denormalized convenience counters, refreshed by services. */
  stats: {
    connectedAccounts: number;
    activeAutomations: number;
    totalLeads: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const workspaceSchema = new Schema<IWorkspace>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    timezone: { type: String, default: 'UTC' },
    stats: {
      connectedAccounts: { type: Number, default: 0 },
      activeAutomations: { type: Number, default: 0 },
      totalLeads: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export const WorkspaceModel = model<IWorkspace>('Workspace', workspaceSchema);
