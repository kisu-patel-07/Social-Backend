import { IUser, UserModel } from '../models/user.model';
import { BaseRepository } from './base.repository';

class UserRepository extends BaseRepository<IUser> {
  constructor() {
    super(UserModel);
  }

  /** Find a user by email. Pass withPassword to include the hashed password. */
  findByEmail(email: string, withPassword = false): Promise<IUser | null> {
    const query = this.model.findOne({ email: email.toLowerCase() });
    if (withPassword) query.select('+password');
    return query.exec();
  }

  findByGoogleId(googleId: string): Promise<IUser | null> {
    return this.findOne({ googleId });
  }

  findByFacebookId(facebookId: string): Promise<IUser | null> {
    return this.findOne({ facebookId });
  }

  /** Increment token version to invalidate all existing refresh tokens. */
  async bumpTokenVersion(userId: string): Promise<void> {
    await this.model.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }).exec();
  }
}

export const userRepository = new UserRepository();
