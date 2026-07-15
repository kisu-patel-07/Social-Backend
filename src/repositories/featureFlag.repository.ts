import { FeatureFlagModel, IFeatureFlag } from '../models/featureFlag.model';
import { BaseRepository } from './base.repository';

class FeatureFlagRepository extends BaseRepository<IFeatureFlag> {
  constructor() {
    super(FeatureFlagModel);
  }

  findByKey(key: string): Promise<IFeatureFlag | null> {
    return this.findOne({ key: key.toLowerCase() });
  }
}

export const featureFlagRepository = new FeatureFlagRepository();
