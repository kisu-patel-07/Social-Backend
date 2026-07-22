import { Schema, model, Document, Types } from 'mongoose';

export interface IWorkspace extends Document {
  _id: Types.ObjectId;
  name: string;
  /** Owning user. Multi-member workspaces are a future phase. */
  owner: Types.ObjectId;
  timezone: string;
  /**
   * AI auto-reply bot: answers DMs that no automation matched, grounded in
   * the workspace's own business context. Off until the user enables it.
   */
  aiAssistant: {
    enabled: boolean;
    /** What the bot knows: about the business, FAQs, links, tone. */
    businessContext: string;
    /** Per-day reply cap so free-tier LLM quotas are never blown. */
    dailyLimit: number;
    /**
     * Bring-your-own-key: when set, AI calls use the workspace's own
     * provider/key (their expense) instead of the platform defaults.
     * Write-only via the API — toJSON strips it and exposes hasOwnKey.
     */
    apiKey: string;
    /** Optional OpenAI-compatible endpoint override (e.g. Groq, OpenAI). */
    baseUrl: string;
    /** Optional model override for the endpoint above. */
    model: string;
  };
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
    aiAssistant: {
      enabled: { type: Boolean, default: false },
      businessContext: { type: String, default: '', maxlength: 4000 },
      dailyLimit: { type: Number, default: 50, min: 1, max: 1000 },
      apiKey: { type: String, default: '', maxlength: 300 },
      baseUrl: { type: String, default: '', maxlength: 300 },
      model: { type: String, default: '', maxlength: 120 },
    },
    stats: {
      connectedAccounts: { type: Number, default: 0 },
      activeAutomations: { type: Number, default: 0 },
      totalLeads: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    toJSON: {
      // The AI API key is write-only: clients only learn whether one is set.
      transform(_doc, ret) {
        const ai = ret.aiAssistant as { apiKey?: string; hasOwnKey?: boolean } | undefined;
        if (ai) {
          ai.hasOwnKey = Boolean(ai.apiKey);
          delete ai.apiKey;
        }
        return ret;
      },
    },
  }
);

export const WorkspaceModel = model<IWorkspace>('Workspace', workspaceSchema);
