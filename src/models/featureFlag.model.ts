import { Schema, model, Document, Types } from 'mongoose';

/** How a feature flag resolves for a workspace. */
export type FeatureFlagMode = 'on' | 'off' | 'allowlist';

/**
 * A platform feature toggle managed from the admin panel.
 * 'on' = everyone, 'off' = kill switch, 'allowlist' = listed workspaces only.
 */
export interface IFeatureFlag extends Document {
  _id: Types.ObjectId;
  /** Stable machine key, e.g. "studio". */
  key: string;
  name: string;
  description?: string;
  mode: FeatureFlagMode;
  /** Workspaces granted access when mode is 'allowlist'. */
  workspaces: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<IFeatureFlag>(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    mode: { type: String, enum: ['on', 'off', 'allowlist'], default: 'on' },
    workspaces: { type: [Schema.Types.ObjectId], ref: 'Workspace', default: [] },
  },
  { timestamps: true }
);

export const FeatureFlagModel = model<IFeatureFlag>('FeatureFlag', featureFlagSchema);
