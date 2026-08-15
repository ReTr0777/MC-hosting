/**
 * The one place the password rule lives.
 *
 * The reset-password route enforced a minimum of 8 while registration enforced nothing, so the
 * same account could be created with a one-character password and then refused that password on
 * reset. The forms now tell the user "at least 8 characters", which is only honest if every route
 * that sets a password agrees.
 */

export const MIN_PASSWORD_LENGTH = 8;

/** Returns the reason the password is unacceptable, or null when it's fine. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return 'A password is required';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
