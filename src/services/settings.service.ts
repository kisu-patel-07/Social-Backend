import { IUser } from '../models/user.model';
import { IWorkspace } from '../models/workspace.model';
import {
  automationRepository,
  conversationRepository,
  keywordRepository,
  leadRepository,
  messageRepository,
  notificationRepository,
  socialAccountRepository,
  subscriptionRepository,
  userRepository,
  workspaceRepository,
} from '../repositories';
import { AuthUser } from '../types/auth.types';
import { BadRequestError, NotFoundError } from '../utils/AppError';
import { comparePassword, hashPassword } from '../utils/password';

interface ProfileUpdate {
  name?: string;
  timezone?: string;
  avatarUrl?: string;
}

interface WorkspaceUpdate {
  name?: string;
  timezone?: string;
}

interface NotificationPrefs {
  newLead?: boolean;
  weeklyReport?: boolean;
  product?: boolean;
}

class SettingsService {
  async getProfile(userId: string): Promise<IUser> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  async updateProfile(userId: string, update: ProfileUpdate): Promise<IUser> {
    const user = await userRepository.updateById(userId, update);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  async getWorkspace(workspaceId: string): Promise<IWorkspace> {
    const workspace = await workspaceRepository.findById(workspaceId);
    if (!workspace) throw new NotFoundError('Workspace not found');
    return workspace;
  }

  async updateWorkspace(workspaceId: string, update: WorkspaceUpdate): Promise<IWorkspace> {
    const workspace = await workspaceRepository.updateById(workspaceId, update);
    if (!workspace) throw new NotFoundError('Workspace not found');
    return workspace;
  }

  async updateNotificationPrefs(userId: string, prefs: NotificationPrefs): Promise<IUser> {
    const set: Record<string, boolean> = {};
    if (prefs.newLead !== undefined) set['notificationPreferences.newLead'] = prefs.newLead;
    if (prefs.weeklyReport !== undefined)
      set['notificationPreferences.weeklyReport'] = prefs.weeklyReport;
    if (prefs.product !== undefined) set['notificationPreferences.product'] = prefs.product;

    const user = await userRepository.updateById(userId, set);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await userRepository.findOne({ _id: userId }, '+password');
    if (!user) throw new NotFoundError('User not found');
    if (!user.password) {
      throw new BadRequestError('This account has no password set (OAuth login)');
    }
    const ok = await comparePassword(currentPassword, user.password);
    if (!ok) throw new BadRequestError('Current password is incorrect');

    user.password = await hashPassword(newPassword);
    await user.save();
    await userRepository.bumpTokenVersion(userId);
  }

  /**
   * Permanently delete the user's account and all workspace data.
   * Verifies the password for local accounts before proceeding.
   */
  async deleteAccount(user: AuthUser, password?: string): Promise<void> {
    const dbUser = await userRepository.findOne({ _id: user.id }, '+password');
    if (!dbUser) throw new NotFoundError('User not found');

    if (dbUser.password) {
      if (!password) throw new BadRequestError('Password is required to delete your account');
      const ok = await comparePassword(password, dbUser.password);
      if (!ok) throw new BadRequestError('Password is incorrect');
    }

    const workspaceId = user.workspaceId;
    // Cascade delete all workspace-scoped data.
    await Promise.all([
      automationRepository.deleteMany({ workspace: workspaceId }),
      keywordRepository.deleteMany({ workspace: workspaceId }),
      messageRepository.deleteMany({ workspace: workspaceId }),
      conversationRepository.deleteMany({ workspace: workspaceId }),
      leadRepository.deleteMany({ workspace: workspaceId }),
      socialAccountRepository.deleteMany({ workspace: workspaceId }),
      notificationRepository.deleteMany({ workspace: workspaceId }),
      subscriptionRepository.deleteMany({ workspace: workspaceId }),
    ]);
    await userRepository.deleteMany({ workspace: workspaceId });
    await workspaceRepository.deleteById(workspaceId);
  }
}

export const settingsService = new SettingsService();
