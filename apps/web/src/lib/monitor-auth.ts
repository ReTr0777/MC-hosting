import crypto from 'crypto';

/**
 * Shared secret between server.js (which drives the interval) and the tick route.
 * Derived rather than configured so no new env var is required to run the monitor.
 */
export function monitorKey(): string {
  const material = process.env.JWT_SECRET || 'super-secret-jwt-token-key-craftcontrol-secure-salt';
  return crypto.createHash('sha256').update(`${material}:craftcontrol-monitor`).digest('hex');
}
