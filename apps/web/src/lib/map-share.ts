import crypto from 'crypto';

/** URL-safe, unguessable share token. */
export function generateShareToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function hashSharePassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySharePassword(password: string, stored: string): boolean {
  try {
    const [salt, expected] = stored.split(':');
    if (!salt || !expected) return false;

    const derived = crypto.scryptSync(password, salt, 32);
    const expectedBuf = Buffer.from(expected, 'hex');
    if (derived.length !== expectedBuf.length) return false;

    return crypto.timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Cookie value proving a visitor cleared the password gate for one specific share.
 * Bound to the stored hash so changing the password invalidates outstanding cookies.
 */
export function shareAccessCookie(token: string, passwordHash: string): string {
  const material = process.env.JWT_SECRET || 'super-secret-jwt-token-key-craftcontrol-secure-salt';
  return crypto.createHmac('sha256', material).update(`${token}:${passwordHash}`).digest('hex');
}

export function shareCookieName(token: string): string {
  // Token is base64url, which is already a legal cookie name character set
  return `mapshare_${token}`;
}

export type ShareState = 'ok' | 'not_found' | 'disabled' | 'expired' | 'map_off';

export function shareStateMessage(state: ShareState): string {
  switch (state) {
    case 'not_found':
      return 'This map link is not valid.';
    case 'disabled':
      return 'This map link has been revoked.';
    case 'expired':
      return 'This map link has expired.';
    case 'map_off':
      return 'The map is not currently enabled for this server.';
    default:
      return '';
  }
}
