import { Schema, model, Document, Types } from 'mongoose';
import { Platform } from '../constants';

export interface ISocialAccount extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  platform: Platform;
  /** Human-readable name (Page name / IG username). */
  name: string;
  username?: string;
  avatarUrl?: string;

  /** Facebook Page ID. Present for both FB and IG (IG connects via a Page). */
  pageId?: string;
  /** Instagram Business Account ID. */
  instagramBusinessId?: string;

  /** Long-lived access token. Excluded from queries by default. */
  accessToken: string;
  /** Some flows return a refresh token; stored when available. */
  refreshToken?: string;
  /** When the current access token expires (used to schedule refresh). */
  tokenExpiresAt?: Date;

  /** Whether webhook subscription is active for this account. */
  isWebhookSubscribed: boolean;
  isActive: boolean;
  /** Last error from Meta (e.g. token revoked), surfaced to the user. */
  lastError?: string;
  connectedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const socialAccountSchema = new Schema<ISocialAccount>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    platform: { type: String, enum: Object.values(Platform), required: true },
    name: { type: String, required: true, trim: true },
    username: { type: String, trim: true },
    avatarUrl: { type: String },

    pageId: { type: String, index: true },
    instagramBusinessId: { type: String, index: true },

    accessToken: { type: String, required: true, select: false },
    refreshToken: { type: String, select: false },
    tokenExpiresAt: { type: Date },

    isWebhookSubscribed: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastError: { type: String },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// A given external account connects only once per workspace+platform.
socialAccountSchema.index(
  { workspace: 1, platform: 1, pageId: 1, instagramBusinessId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

socialAccountSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const obj = ret as unknown as Record<string, unknown>;
    delete obj.accessToken;
    delete obj.refreshToken;
    delete obj.__v;
    return obj;
  },
});

export const SocialAccountModel = model<ISocialAccount>('SocialAccount', socialAccountSchema);
