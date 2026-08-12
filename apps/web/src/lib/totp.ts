import { authenticator } from 'otplib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

export function totpKeyUri(secret: string, email: string): string {
  return authenticator.keyuri(email, 'CraftControl', secret);
}

/** Generates 10 human-readable one-time backup codes plus their bcrypt hashes for storage. */
export async function generateBackupCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(5).toString('hex'));
  }
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
  return { codes, hashes };
}

/** Checks a raw backup code against stored hashes, returning the matched hash (to remove it) or null. */
export async function matchBackupCode(rawCode: string, hashes: string[]): Promise<string | null> {
  for (const hash of hashes) {
    if (await bcrypt.compare(rawCode, hash)) return hash;
  }
  return null;
}
