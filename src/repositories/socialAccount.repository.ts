import { ISocialAccount, SocialAccountModel } from '../models/socialAccount.model';
import { Platform } from '../constants';
import { BaseRepository } from './base.repository';

class SocialAccountRepository extends BaseRepository<ISocialAccount> {
  constructor() {
    super(SocialAccountModel);
  }

  /** List active accounts for a workspace (tokens excluded by schema default). */
  listByWorkspace(workspaceId: string): Promise<ISocialAccount[]> {
    return this.find({ workspace: workspaceId, isActive: true }, undefined, {
      sort: { createdAt: -1 },
    });
  }

  /** Resolve the connected account that owns an incoming webhook event. */
  findByPageId(pageId: string): Promise<ISocialAccount | null> {
    return this.model.findOne({ pageId, isActive: true }).select('+accessToken').exec();
  }

  findByInstagramBusinessId(igId: string): Promise<ISocialAccount | null> {
    return this.model
      .findOne({ instagramBusinessId: igId, isActive: true })
      .select('+accessToken')
      .exec();
  }

  /** Load an account including its (normally hidden) access token. */
  findWithToken(id: string): Promise<ISocialAccount | null> {
    return this.model.findById(id).select('+accessToken +refreshToken').exec();
  }

  /** Accounts whose tokens expire before the given date (refresh candidates). */
  findExpiringTokens(before: Date): Promise<ISocialAccount[]> {
    return this.model
      .find({ isActive: true, tokenExpiresAt: { $lte: before } })
      .select('+accessToken +refreshToken')
      .exec();
  }

  countActiveByWorkspace(workspaceId: string, platform?: Platform): Promise<number> {
    return this.count({
      workspace: workspaceId,
      isActive: true,
      ...(platform ? { platform } : {}),
    });
  }
}

export const socialAccountRepository = new SocialAccountRepository();
