import crypto from 'crypto';

/** Generate a cryptographically random 6-digit one-time code. */
export function generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Hash an OTP for storage — codes are never persisted in plaintext. */
export function hashOtp(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Constant-time comparison of a submitted code against the stored hash. */
export function verifyOtp(code: string, storedHash: string): boolean {
  const submitted = Buffer.from(hashOtp(code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return submitted.length === stored.length && crypto.timingSafeEqual(submitted, stored);
}
