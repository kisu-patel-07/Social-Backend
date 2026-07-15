import { Types } from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { IFeatureFlag, FeatureFlagMode } from '../models/featureFlag.model';
import { featureFlagRepository } from '../repositories';
import { AppError } from '../utils/AppError';
import { HttpStatus } from '../constants/httpStatus';

/**
 * Flags known to the platform. Missing flags are lazily seeded with their
 * default so the admin panel always shows the full set.
 */
const KNOWN_FLAGS: Array<Pick<IFeatureFlag, 'key' | 'name' | 'description' | 'mode'>> = [
  {
    key: 'studio',
    name: 'Automation Studio',
    description: 'The v2 automation builder (Studio tab). Kill switch + gradual rollout.',
    mode: 'on', // Studio predates flags — default on so nobody loses access.
  },
];

class FeatureService {
  /** All flags, seeding any known flag that does not exist yet. */
  async listFlags(): Promise<IFeatureFlag[]> {
    for (const flag of KNOWN_FLAGS) {
      await featureFlagRepository.updateOne(
        { key: flag.key },
        { $setOnInsert: flag },
        { new: true, upsert: true }
      );
    }
    return featureFlagRepository.find({}, undefined, {
      sort: { key: 1 },
      populate: { path: 'workspaces', select: 'name' },
    });
  }

  async updateFlag(
    key: string,
    params: { mode?: FeatureFlagMode; description?: string; workspaces?: string[] }
  ): Promise<IFeatureFlag> {
    const set: Record<string, unknown> = {};
    if (params.mode) set.mode = params.mode;
    if (params.description !== undefined) set.description = params.description;
    if (params.workspaces) {
      set.workspaces = params.workspaces.map((id) => new Types.ObjectId(id));
    }
    const updated = await featureFlagRepository.updateOne(
      { key: key.toLowerCase() },
      { $set: set }
    );
    if (!updated) {
      throw new AppError('Feature flag not found', HttpStatus.NOT_FOUND, {
        errorCode: 'NOT_FOUND',
      });
    }
    await updated.populate({ path: 'workspaces', select: 'name' });
    return updated;
  }

  /** Resolve whether a feature is enabled for a workspace. Unknown flags = on. */
  async isEnabled(key: string, workspaceId: string): Promise<boolean> {
    const flag = await featureFlagRepository.findByKey(key);
    if (!flag) return true; // unseeded/unknown flags never block users
    if (flag.mode === 'on') return true;
    if (flag.mode === 'off') return false;
    return flag.workspaces.some((w) => w.toString() === workspaceId);
  }

  /** The flag map handed to the client on /users/me. */
  async flagsForWorkspace(workspaceId: string): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      KNOWN_FLAGS.map(async (f) => [f.key, await this.isEnabled(f.key, workspaceId)] as const)
    );
    return Object.fromEntries(entries);
  }
}

export const featureService = new FeatureService();

/**
 * Route guard: 403 with FEATURE_DISABLED when the workspace does not have the
 * feature. Must run after `authenticate`.
 */
export function requireFeature(key: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const enabled = await featureService.isEnabled(key, req.user!.workspaceId);
      if (!enabled) {
        throw new AppError('This feature is not enabled for your workspace', HttpStatus.FORBIDDEN, {
          errorCode: 'FEATURE_DISABLED',
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
