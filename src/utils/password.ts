import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { env } from '../config/env';

/** Hash a plaintext password using bcrypt. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_SALT_ROUNDS);
}

/** Compare a plaintext password against a stored hash. */
export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Generate a cryptographically random URL-safe token (e.g. for state params). */
export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
