import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

/** Key material used before SECRET_ENCRYPTION_KEY existed, when JWT_SECRET was unset. */
const LEGACY_KEY_MATERIAL = 'super-secret-jwt-token-key-craftcontrol-secure-salt';

function deriveKey(material: string): Buffer {
  return crypto.scryptSync(material, 'craftcontrol-salt', 32);
}

/**
 * Key material for encrypting NEW secrets. Prefer a dedicated variable: JWT_SECRET is a
 * session concern that gets rotated freely, and tying secrets-at-rest to it means a
 * rotation silently shreds every secret stored in SystemSetting.
 */
function primaryKeyMaterial(): string {
  return process.env.SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET || LEGACY_KEY_MATERIAL;
}

/**
 * Every key a stored secret might have been encrypted under, most-preferred first.
 * Lets an existing deployment adopt SECRET_ENCRYPTION_KEY without re-entering its secrets.
 */
function candidateKeyMaterials(): string[] {
  const candidates = [
    process.env.SECRET_ENCRYPTION_KEY,
    process.env.JWT_SECRET,
    LEGACY_KEY_MATERIAL,
  ].filter((m): m is string => !!m);

  return Array.from(new Set(candidates));
}

export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypts sensitive string (e.g. Cloudflare API tokens, Node secret keys)
 */
export function encryptSecret(text: string): string {
  if (!text) return '';
  // Already in iv:tag:ciphertext form — don't double-encrypt
  if (isEncryptedSecret(text)) return text;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(primaryKeyMaterial()), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export type DecryptStatus = 'empty' | 'ok' | 'undecryptable';

export interface DecryptResult {
  status: DecryptStatus;
  value: string;
  /** True when the value decrypted under a fallback key and should be re-saved under the primary one. */
  needsReEncryption: boolean;
}

/**
 * Decrypts a stored secret, reporting *why* it failed rather than guessing.
 */
export function tryDecryptSecret(encryptedText: string): DecryptResult {
  if (!encryptedText) return { status: 'empty', value: '', needsReEncryption: false };

  // Legacy rows predate encryption at rest and are stored as plaintext
  if (!isEncryptedSecret(encryptedText)) {
    return { status: 'ok', value: encryptedText, needsReEncryption: true };
  }

  const parts = encryptedText.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return { status: 'undecryptable', value: '', needsReEncryption: false };

  const [ivHex, authTagHex, payload] = parts;
  const materials = candidateKeyMaterials();

  for (let i = 0; i < materials.length; i++) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(materials[i]), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

      let decrypted = decipher.update(payload, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return { status: 'ok', value: decrypted, needsReEncryption: i > 0 };
    } catch (err) {
      // Wrong key for this candidate — GCM auth tag rejected it. Try the next.
    }
  }

  return { status: 'undecryptable', value: '', needsReEncryption: false };
}

/**
 * Returns plaintext, or '' when the stored value cannot be decrypted.
 *
 * Never returns the ciphertext on failure: callers forward this value straight into
 * upstream Authorization headers, and handing back "enc:..." produced misleading
 * third-party auth errors instead of surfacing the real key-mismatch problem.
 */
export function decryptSecret(encryptedText: string): string {
  return tryDecryptSecret(encryptedText).value;
}

/**
 * Masks sensitive API tokens for UI presentation (e.g., "vK8x••••••••9F2a")
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const plain = decryptSecret(secret);
  if (!plain) return '';
  if (plain.length <= 8) return '••••••••';
  return `${plain.substring(0, 4)}••••••••${plain.substring(plain.length - 4)}`;
}
