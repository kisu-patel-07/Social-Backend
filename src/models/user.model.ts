import { Schema, model, Document, Types } from 'mongoose';
import { AuthProvider, UserRole } from '../constants';

export interface IUser extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  name: string;
  email: string;
  /** Hashed password. Absent for pure OAuth accounts. Excluded from queries by default. */
  password?: string;
  role: UserRole;
  authProviders: AuthProvider[];
  googleId?: string;
  facebookId?: string;
  avatarUrl?: string;
  isEmailVerified: boolean;
  /**
   * Platform-level operator flag, distinct from the workspace `role`.
   * Grants access to the /admin panel; never assignable via the public API.
   */
  isSuperAdmin: boolean;
  /** Suspended users cannot sign in or refresh a session. */
  isSuspended: boolean;
  suspendedAt?: Date;
  /** TOTP 2FA (offered to super admins). Secret excluded from queries by default. */
  totpSecret?: string;
  isTotpEnabled: boolean;
  /** Internal support notes, visible ONLY in the admin panel. Excluded by default. */
  adminNotes?: string;
  /** Hashed email-verification OTP. Excluded from queries by default. */
  emailOtpHash?: string;
  emailOtpExpiresAt?: Date;
  /** Failed OTP attempts since the last code was issued. */
  emailOtpAttempts?: number;
  /** When the last verification email was sent (resend cooldown). */
  emailOtpSentAt?: Date;
  lastLoginAt?: Date;
  /** Salt rotated on logout-all / password change to invalidate refresh tokens. */
  tokenVersion: number;
  notificationPreferences: {
    newLead: boolean;
    weeklyReport: boolean;
    product: boolean;
  };
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: { type: String, select: false },
    role: { type: String, enum: Object.values(UserRole), default: UserRole.OWNER },
    authProviders: {
      type: [String],
      enum: Object.values(AuthProvider),
      default: [AuthProvider.LOCAL],
    },
    googleId: { type: String, index: true, sparse: true },
    facebookId: { type: String, index: true, sparse: true },
    avatarUrl: { type: String },
    isEmailVerified: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false, index: true },
    isSuspended: { type: Boolean, default: false },
    suspendedAt: { type: Date },
    totpSecret: { type: String, select: false },
    isTotpEnabled: { type: Boolean, default: false },
    adminNotes: { type: String, select: false, maxlength: 5000 },
    emailOtpHash: { type: String, select: false },
    emailOtpExpiresAt: { type: Date, select: false },
    emailOtpAttempts: { type: Number, default: 0, select: false },
    emailOtpSentAt: { type: Date, select: false },
    lastLoginAt: { type: Date },
    tokenVersion: { type: Number, default: 0 },
    notificationPreferences: {
      newLead: { type: Boolean, default: true },
      weeklyReport: { type: Boolean, default: true },
      product: { type: Boolean, default: true },
    },
    timezone: { type: String, default: 'UTC' },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const obj = ret as unknown as Record<string, unknown>;
    delete obj.password;
    delete obj.totpSecret;
    delete obj.adminNotes;
    delete obj.emailOtpHash;
    delete obj.emailOtpExpiresAt;
    delete obj.emailOtpAttempts;
    delete obj.emailOtpSentAt;
    delete obj.__v;
    return obj;
  },
});

export const UserModel = model<IUser>('User', userSchema);
