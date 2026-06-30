import { IKeyword, KeywordModel } from '../models/keyword.model';
import { BaseRepository } from './base.repository';

class KeywordRepository extends BaseRepository<IKeyword> {
  constructor() {
    super(KeywordModel);
  }

  /** Return any of the given keyword values already used on a social account. */
  async findDuplicates(
    socialAccountId: string,
    values: string[],
    excludeAutomationId?: string
  ): Promise<string[]> {
    const docs = await this.find({
      socialAccount: socialAccountId,
      value: { $in: values.map((v) => v.toLowerCase().trim()) },
      ...(excludeAutomationId ? { automation: { $ne: excludeAutomationId } } : {}),
    });
    return docs.map((d) => d.value);
  }

  deleteByAutomation(automationId: string): Promise<number> {
    return this.deleteMany({ automation: automationId });
  }

  async incrementMatch(socialAccountId: string, value: string): Promise<void> {
    await this.model
      .updateOne(
        { socialAccount: socialAccountId, value: value.toLowerCase().trim() },
        { $inc: { matchCount: 1 } }
      )
      .exec();
  }
}

export const keywordRepository = new KeywordRepository();
