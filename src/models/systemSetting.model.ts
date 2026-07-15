import { Schema, model, Document } from 'mongoose';

export type BannerLevel = 'info' | 'warning' | 'critical';

/** The user-facing maintenance/announcement banner shown across the app. */
export interface ISystemBanner {
  enabled: boolean;
  message: string;
  level: BannerLevel;
}

/**
 * Singleton document (key: 'global') holding platform-wide operator settings.
 * Kept schemaless-adjacent so future settings slot in without a migration.
 */
export interface ISystemSetting extends Document {
  key: string;
  banner: ISystemBanner;
  updatedAt: Date;
  createdAt: Date;
}

const systemSettingSchema = new Schema<ISystemSetting>(
  {
    key: { type: String, required: true, unique: true },
    banner: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: '' },
      level: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    },
  },
  { timestamps: true }
);

export const SystemSettingModel = model<ISystemSetting>('SystemSetting', systemSettingSchema);
