import { Schema, model, Document, Types } from 'mongoose';
import { KeywordMatchType } from '../constants';

/**
 * Keywords are stored both denormalized on the Automation (for fast matching)
 * and as first-class documents here. This collection enforces uniqueness of a
 * keyword per social account and powers keyword-level analytics.
 */
export interface IKeyword extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  automation: Types.ObjectId;
  socialAccount: Types.ObjectId;
  /** Normalized (lowercased, trimmed) keyword text. */
  value: string;
  matchType: KeywordMatchType;
  /** Number of comments that matched this keyword. */
  matchCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const keywordSchema = new Schema<IKeyword>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    automation: { type: Schema.Types.ObjectId, ref: 'Automation', required: true, index: true },
    socialAccount: {
      type: Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
      index: true,
    },
    value: { type: String, required: true, lowercase: true, trim: true },
    matchType: {
      type: String,
      enum: Object.values(KeywordMatchType),
      default: KeywordMatchType.CONTAINS,
    },
    matchCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// A keyword must be unique per social account (prevents ambiguous routing).
keywordSchema.index({ socialAccount: 1, value: 1 }, { unique: true });

export const KeywordModel = model<IKeyword>('Keyword', keywordSchema);
