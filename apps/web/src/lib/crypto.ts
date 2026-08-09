import crypto from 'crypto';

const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.JWT_SECRET || 'super-secret-jwt-token-key-craftcontrol-secure-salt',
  'craftcontrol-salt',
  32
);

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts sensitive string (e.g. Cloudflare API tokens, Node secret keys)
 */
export function encryptSecret(text: string): string {
  if (!text) return '';
  // If already encrypted format (iv:ciphertext:tag)
  if (text.startsWith('enc:')) return text;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts sensitive string
 */
export function decryptSecret(encryptedText: string): string {
  if (!encryptedText) return '';
  if (!encryptedText.startsWith('enc:')) return encryptedText; // Fallback for unencrypted legacy data

  try {
    const parts = encryptedText.replace('enc:', '').split(':');
    if (parts.length !== 3) return encryptedText;

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    return encryptedText;
  }
}

/**
 * Masks sensitive API tokens for UI presentation (e.g., "vK8x...9F2a")
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const plain = decryptSecret(secret);
  if (plain.length <= 8) return '••••••••';
  return `${plain.substring(0, 4)}••••••••${plain.substring(plain.length - 4)}`;
}
