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
import {
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
  verifyEmailToken,
  verifyRefreshToken,
} from '../utils/jwt';
import { comparePassword, hashPassword } from '../utils/password';
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

    // Attach a trial of the cheapest active plan, if one is seeded.
    const plan =
      (await planRepository.findByCode('free')) ?? (await planRepository.listActive())[0];
    if (plan) {
      await subscriptionRepository.create({
        workspace: workspace._id,
        plan: plan._id,
        status: SubscriptionStatus.TRIALING,
        currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), 14),
        trialEndsAt: addDays(new Date(), 14),
      });
    }

    return workspace._id;
  }

  /** Send the email-verification message for a user. */
  private async dispatchVerification(user: IUser): Promise<void> {
    const token = signEmailToken(
      user._id.toString(),
      TokenType.EMAIL_VERIFICATION,
      env.EMAIL_TOKEN_EXPIRES_IN
    );
    const verifyUrl = `${env.CLIENT_URL.split(',')[0]}/verify-email?token=${token}`;
    await emailService.sendVerification(user.email, user.name, verifyUrl);
  }

  async register(params: RegisterParams, ip?: string): Promise<AuthResult> {
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

    await Promise.all([
      this.dispatchVerification(user),
      emailService.sendWelcome(user.email, user.name),
      activityService.log({
        workspace: workspaceId.toString(),
        user: user._id.toString(),
        action: ActivityAction.USER_REGISTERED,
        description: `${user.name} registered`,
        ip,
      }),
    ]);

    return { user, tokens: this.issueTokens(user) };
  }

  async login(email: string, password: string, ip?: string): Promise<AuthResult> {
    const user = await userRepository.findByEmail(email, true);
    if (!user || !user.password) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const ok = await comparePassword(password, user.password);
    if (!ok) {
      throw new UnauthorizedError('Invalid email or password');
    }

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
    return this.issueTokens(user);
  }

  async verifyEmail(token: string): Promise<void> {
    const payload = verifyEmailToken(token, TokenType.EMAIL_VERIFICATION);
    const user = await userRepository.findById(payload.sub);
    if (!user) throw new NotFoundError('User not found');
    if (user.isEmailVerified) return;
    await userRepository.updateById(user._id, { isEmailVerified: true });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await userRepository.findByEmail(email);
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
    return { user, tokens: this.issueTokens(user) };
  }
}

export const authService = new AuthService();
