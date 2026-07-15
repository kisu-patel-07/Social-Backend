import { authenticator } from 'otplib';
import QRCode from 'qrcode';

/** Tolerate one 30s step of clock drift between server and authenticator app. */
authenticator.options = { window: 1 };

const ISSUER = 'SocialFlow';

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/** otpauth:// URI encoding the account + secret for authenticator apps. */
export function buildTotpUri(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret);
}

/** Render the otpauth URI as a data-URL QR code for on-screen enrollment. */
export function totpQrDataUrl(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri, { margin: 1, width: 240 });
}

export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}
