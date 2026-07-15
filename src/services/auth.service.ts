import { Types } from 'mongoose';
import { env } from '../config/env';
import {
  ActivityAction,
  AuthProvider,
  SubscriptionStatus,
  TokenType,
  UserRole,
} from '../constants';
import { IUser } from '../models/user.model';
import {
  planRepository,
  subscriptionRepository,
  userRepository,
  workspaceRepository,
} from '../repositories';
import { AuthTokens, JwtPayload } from '../types/auth.types';
import { HttpStatus } from '../constants/httpStatus';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/AppError';
import { addDays } from '../utils/date';
import {
  signAccessToken,
  signEmailToken,
  signRefreshToken,
  signTotpChallengeToken,
  verifyEmailToken,
  verifyRefreshToken,
  verifyTotpChallengeToken,
} from '../utils/jwt';
import { generateOtp, hashOtp, verifyOtp } from '../utils/otp';
import { comparePassword, hashPassword } from '../utils/password';
import { verifyTotpCode } from '../utils/totp';
import { activityService } from './activity.service';
import { emailService } from './email/email.service';

interface RegisterParams {
  name: string;
  email: string;
  password: string;
  workspaceName?: string;
}

interface AuthResult {
  user: IUser;
  tokens: AuthTokens;
}

/** Returned instead of tokens when the account has TOTP 2FA enabled. */
export interface TotpChallenge {
  requiresTotp: true;
  challengeToken: string;
}

export function isTotpChallenge(result: AuthResult | TotpChallenge): result is TotpChallenge {
  return (result as TotpChallenge).requiresTotp === true;
}

/** How long an email-verification OTP stays valid. */
const OTP_TTL_MINUTES = 10;
/** Wrong-code attempts allowed before a new code must be requested. */
const OTP_MAX_ATTEMPTS = 5;
/** Minimum seconds between verification emails (resend cooldown). */
const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** 403 raised when a user tries to sign in before verifying their email. */
function emailNotVerifiedError(): AppError {
  return new AppError('Please verify your email address to continue', HttpStatus.FORBIDDEN, {
    errorCode: 'EMAIL_NOT_VERIFIED',
  });
}

/** 403 raised when a suspended account tries to sign in or refresh. */
function accountSuspendedError(): AppError {
  return new AppError('This account has been suspended. Contact support.', HttpStatus.FORBIDDEN, {
    errorCode: 'ACCOUNT_SUSPENDED',
  });
}

class AuthService {
  /** Issue an access + refresh token pair for a user. */
  private issueTokens(user: IUser): AuthTokens {
    const payload: JwtPayload = {
      sub: user._id.toString(),
      workspaceId: user.workspace.toString(),
      role: user.role,
      email: user.email,
    };
    return {
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    };
  }

  /** Create a workspace + default trial subscription for a brand-new user. */
  private async bootstrapWorkspace(name: string, ownerId: Types.ObjectId): Promise<Types.ObjectId> {
    const workspace = await workspaceRepository.create({
      name,
      owner: ownerId,
    });

    // Every new workspace starts on the Free plan (active, no trial); users
    // upgrade to a paid plan via Razorpay checkout whenever they need more.
    const plan =
      (await planRepository.findByCode('free')) ?? (await planRepository.listActive())[0];
    if (plan) {
      await subscriptionRepository.create({
        workspace: workspace._id,
        plan: plan._id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date(),
        // Free never lapses; a far-future period end keeps the model happy.
        currentPeriodEnd: addDays(new Date(), 3650),
      });
    }

    return workspace._id;
  }

  /**
   * Send the email-verification message for a user. The email carries both a
   * one-click link and a 6-digit code; the code (hashed) and its expiry are
   * stored on the user. Respects the resend cooldown unless `force` is set.
   *
   * Returns whether a code was actually emailed:
   * - false when skipped by the resend cooldown, or when the send failed.
   * Never throws — callers use the boolean to decide what to tell the user.
   */
  private async dispatchVerification(user: IUser, force = false): Promise<boolean> {
    if (!force && user.emailOtpSentAt) {
      const elapsed = (Date.now() - user.emailOtpSentAt.getTime()) / 1000;
      if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) return false;
    }

    const otp = generateOtp();
    await userRepository.updateById(user._id, {
      $set: {
        emailOtpHash: hashOtp(otp),
        emailOtpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        emailOtpAttempts: 0,
        emailOtpSentAt: new Date(),
      },
    });

    const token = signEmailToken(
      user._id.toString(),
      TokenType.EMAIL_VERIFICATION,
      env.EMAIL_TOKEN_EXPIRES_IN
    );
    const verifyUrl = `${env.CLIENT_URL.split(',')[0]}/verify-email?token=${token}`;

    try {
      await emailService.sendVerification(user.email, user.name, verifyUrl, otp);
      return true;
    } catch {
      // Already logged in the mail client. The OTP is stored, so the user can
      // still verify once delivery is fixed / they hit "Resend".
      return false;
    }
  }

  async register(
    params: RegisterParams,
    ip?: string
  ): Promise<{ user: IUser; emailSent: boolean }> {
    const existing = await userRepository.findByEmail(params.email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const passwordHash = await hashPassword(params.password);

    // Create the user first (workspace needs the owner id), then link the workspace.
    const userId = new Types.ObjectId();
    const workspaceId = await this.bootstrapWorkspace(
      params.workspaceName?.trim() || `${params.name}'s Workspace`,
      userId
    );

    const user = await userRepository.create({
      _id: userId,
      workspace: workspaceId,
      name: params.name,
      email: params.email,
      password: passwordHash,
      role: UserRole.OWNER,
      authProviders: [AuthProvider.LOCAL],
    });

    await activityService.log({
      workspace: workspaceId.toString(),
      user: user._id.toString(),
      action: ActivityAction.USER_REGISTERED,
      description: `${user.name} registered`,
      ip,
    });

    // Send the verification code and report whether it actually went out, so
    // the client can guide the user to "Resend" instead of waiting on a code
    // that never arrives. Welcome email is deferred until they verify.
    const emailSent = await this.dispatchVerification(user);

    // No session yet — the account must verify its email before signing in.
    return { user, emailSent };
  }

  async login(email: string, password: string, ip?: string): Promise<AuthResult | TotpChallenge> {
    const user = await userRepository.findByEmail(email, true);
    if (!user || !user.password) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const ok = await comparePassword(password, user.password);
    if (!ok) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (user.isSuspended) {
      throw accountSuspendedError();
    }

    if (!user.isEmailVerified) {
      // Hard block: no session until the email is verified. Re-send a fresh
      // code (cooldown-guarded) so the verify screen the user lands on works.
      const withOtp = await userRepository.findByEmailWithOtp(email);
      if (withOtp) await this.dispatchVerification(withOtp);
      throw emailNotVerifiedError();
    }

    // 2FA-enabled accounts get a short-lived challenge instead of tokens.
    if (user.isTotpEnabled) {
      return { requiresTotp: true, challengeToken: signTotpChallengeToken(user._id.toString()) };
    }

    return this.finalizeLogin(user, ip);
  }

  /** Exchange a TOTP challenge + authenticator code for a real session. */
  async completeTotpLogin(challengeToken: string, code: string, ip?: string): Promise<AuthResult> {
    const { userId } = verifyTotpChallengeToken(challengeToken);
    const user = await userRepository.findById(userId, '+totpSecret');
    if (!user || !user.isTotpEnabled || !user.totpSecret) {
      throw new UnauthorizedError('2FA is not enabled for this account');
    }
    if (user.isSuspended) throw accountSuspendedError();
    if (!verifyTotpCode(code, user.totpSecret)) {
      throw new UnauthorizedError('Incorrect authentication code');
    }
    user.totpSecret = undefined;
    return this.finalizeLogin(user, ip);
  }

  /** Shared tail of every successful password login: stamp, audit, issue tokens. */
  private async finalizeLogin(user: IUser, ip?: string): Promise<AuthResult> {
    await userRepository.updateById(user._id, { lastLoginAt: new Date() });
    await activityService.log({
      workspace: user.workspace.toString(),
      user: user._id.toString(),
      action: ActivityAction.USER_LOGGED_IN,
      description: `${user.name} logged in`,
      ip,
    });

    user.password = undefined;
    return { user, tokens: this.issueTokens(user) };
  }

  /** Rotate tokens from a valid refresh token. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = verifyRefreshToken(refreshToken);
    const user = await userRepository.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedError('User no longer exists');
    }
    // Suspension takes effect as soon as the current access token expires.
    if (user.isSuspended) throw accountSuspendedError();
    // Sessions issued before this policy shipped must also verify.
    if (!user.isEmailVerified) throw emailNotVerifiedError();
    return this.issueTokens(user);
  }

  /** Mark a user verified, clear OTP state, and send the welcome email. */
  private async markVerified(user: IUser): Promise<IUser> {
    const updated = await userRepository.updateById(user._id, {
      $set: { isEmailVerified: true },
      $unset: { emailOtpHash: '', emailOtpExpiresAt: '', emailOtpSentAt: '' },
    });
    // Welcome only after they've proven the mailbox — best-effort, never blocks.
    void emailService.sendWelcome(user.email, user.name);
    return updated ?? user;
  }

  /**
   * Verify via the emailed link token. Proof of mailbox ownership, so a
   * session is issued on success — the user lands signed in.
   */
  async verifyEmail(token: string): Promise<AuthResult> {
    const payload = verifyEmailToken(token, TokenType.EMAIL_VERIFICATION);
    const user = await userRepository.findById(payload.sub);
    if (!user) throw new NotFoundError('User not found');
    if (user.isEmailVerified) {
      // Don't let old links double as permanent sign-in links.
      throw new BadRequestError('This email is already verified. Please sign in.');
    }
    const verified = await this.markVerified(user);
    return { user: verified, tokens: this.issueTokens(verified) };
  }

  /**
   * Verify via the emailed 6-digit code. Codes are hashed at rest, expire
   * after OTP_TTL_MINUTES, and allow OTP_MAX_ATTEMPTS wrong guesses before a
   * fresh code must be requested. Issues a session on success.
   */
  async verifyEmailOtp(email: string, code: string): Promise<AuthResult> {
    const user = await userRepository.findByEmailWithOtp(email);
    // Same message for unknown email / missing code / wrong code — no oracle.
    const invalid = new BadRequestError('Invalid or expired code. Request a new one.');

    if (!user) throw invalid;
    if (user.isEmailVerified) {
      throw new BadRequestError('This email is already verified. Please sign in.');
    }
    if (!user.emailOtpHash || !user.emailOtpExpiresAt) throw invalid;
    if (user.emailOtpExpiresAt.getTime() < Date.now()) throw invalid;
    if ((user.emailOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestError('Too many incorrect attempts. Request a new code.');
    }

    if (!verifyOtp(code, user.emailOtpHash)) {
      await userRepository.updateById(user._id, { $inc: { emailOtpAttempts: 1 } });
      throw invalid;
    }

    const verified = await this.markVerified(user);
    return { user: verified, tokens: this.issueTokens(verified) };
  }

  async resendVerification(email: string): Promise<void> {
    const user = await userRepository.findByEmailWithOtp(email);
    // Do not reveal whether the email exists.
    if (!user || user.isEmailVerified) return;
    await this.dispatchVerification(user);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await userRepository.findByEmail(email);
    if (!user) return; // silent — avoid user enumeration
    const token = signEmailToken(
      user._id.toString(),
      TokenType.PASSWORD_RESET,
      env.PASSWORD_RESET_EXPIRES_IN
    );
    const resetUrl = `${env.CLIENT_URL.split(',')[0]}/reset-password?token=${token}`;
    await emailService.sendPasswordReset(user.email, user.name, resetUrl);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const payload = verifyEmailToken(token, TokenType.PASSWORD_RESET);
    const user = await userRepository.findById(payload.sub);
    if (!user) throw new NotFoundError('User not found');
    const passwordHash = await hashPassword(newPassword);
    await userRepository.updateById(user._id, { password: passwordHash });
    // Invalidate existing sessions.
    await userRepository.bumpTokenVersion(user._id.toString());
  }

  /**
   * Authenticate (or provision) a user via Facebook Login.
   * The frontend obtains a user access token from the Facebook SDK and posts it.
   * Verifying the token against Meta is handled where credentials are present;
   * here we map/create the local user. `profile` is the verified FB profile.
   */
  async loginWithFacebook(profile: {
    facebookId: string;
    name: string;
    email?: string;
  }): Promise<AuthResult> {
    let user = await userRepository.findByFacebookId(profile.facebookId);

    if (!user && profile.email) {
      user = await userRepository.findByEmail(profile.email);
      if (user) {
        // Link Facebook to an existing local account.
        user = await userRepository.updateById(user._id, {
          facebookId: profile.facebookId,
          $addToSet: { authProviders: AuthProvider.FACEBOOK },
          isEmailVerified: true,
        });
      }
    }

    if (!user) {
      const email = profile.email ?? `${profile.facebookId}@facebook.local`;
      const userId = new Types.ObjectId();
      const workspaceId = await this.bootstrapWorkspace(`${profile.name}'s Workspace`, userId);
      user = await userRepository.create({
        _id: userId,
        workspace: workspaceId,
        name: profile.name,
        email,
        facebookId: profile.facebookId,
        role: UserRole.OWNER,
        authProviders: [AuthProvider.FACEBOOK],
        isEmailVerified: Boolean(profile.email),
      });
    }

    if (!user) throw new BadRequestError('Unable to authenticate with Facebook');
    if (user.isSuspended) throw accountSuspendedError();
    return { user, tokens: this.issueTokens(user) };
  }
}

export const authService = new AuthService();
