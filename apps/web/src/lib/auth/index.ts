import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isUserSuspended } from '@/lib/servers/suspension';

export const API_KEY_PREFIX = 'mck_';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'super-secret-jwt-token-key');
export const COOKIE_NAME = 'craft_auth_token';

export interface JwtPayload {
  userId: string;
  email: string;
  username: string;
  globalRole: 'GLOBAL_ADMIN' | 'USER';
}

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

export async function signJwtToken(payload: JwtPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(JWT_SECRET);
}

export async function verifyJwtToken(token: string): Promise<JwtPayload | null> {
  try {
    const verified = await jwtVerify(token, JWT_SECRET);
    return verified.payload as unknown as JwtPayload;
  } catch (err) {
    return null;
  }
}

/** Looks up an ApiKey by its raw token and synthesizes a session-shaped payload for the owning user. */
async function getUserFromApiKey(rawKey: string): Promise<JwtPayload | null> {
  const tokenHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const apiKey = await prisma.apiKey.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!apiKey) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
  if (apiKey.user.suspendedAt) return null;

  // Fire-and-forget usage tracking — must not block or fail the request.
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return {
    userId: apiKey.user.id,
    email: apiKey.user.email,
    username: apiKey.user.username,
    globalRole: apiKey.user.globalRole as 'GLOBAL_ADMIN' | 'USER',
  };
}

export async function getUserFromRequest(req: NextRequest): Promise<JwtPayload | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value || req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  if (token.startsWith(API_KEY_PREFIX)) return await getUserFromApiKey(token);

  const payload = await verifyJwtToken(token);
  if (!payload) return null;

  // Sessions are stateless JWTs, so a suspension would otherwise not take effect until the
  // token expired seven days later. One indexed lookup per request is the price of suspending
  // somebody who is currently signed in and having it mean something immediately.
  if (await isUserSuspended(payload.userId)) return null;

  return payload;
}

export interface PreAuthPayload {
  userId: string;
  purpose: '2fa';
}

/** Short-lived token proving password was correct but 2FA is still outstanding. Never a session credential on its own. */
export async function signPreAuthToken(userId: string): Promise<string> {
  return await new SignJWT({ userId, purpose: '2fa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(JWT_SECRET);
}

export async function verifyPreAuthToken(token: string): Promise<string | null> {
  try {
    const verified = await jwtVerify(token, JWT_SECRET);
    const payload = verified.payload as unknown as PreAuthPayload;
    if (payload.purpose !== '2fa' || !payload.userId) return null;
    return payload.userId;
  } catch {
    return null;
  }
}
