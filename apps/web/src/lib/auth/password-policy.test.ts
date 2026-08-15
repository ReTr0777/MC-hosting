import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePassword, MIN_PASSWORD_LENGTH } from './password-policy';

/**
 * Registration used to enforce nothing while reset enforced eight characters, so an account could
 * be created with a password it would later refuse to restore. Every route that sets a password
 * now goes through here.
 */

test('a password at the minimum length is accepted', () => {
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)), null);
});

test('a password one character short is rejected', () => {
  const problem = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
  assert.match(problem ?? '', /at least 8 characters/);
});

test('a missing or empty password is rejected', () => {
  assert.match(validatePassword('') ?? '', /required/);
  assert.match(validatePassword(undefined) ?? '', /required/);
  assert.match(validatePassword(null) ?? '', /required/);
});

/** A JSON body can carry any type; a number must not slip through to the hasher. */
test('a non-string password is rejected rather than coerced', () => {
  assert.match(validatePassword(12345678) ?? '', /required/);
  assert.match(validatePassword({ length: 20 }) ?? '', /required/);
});

test('long passwords are not truncated or refused', () => {
  assert.equal(validatePassword('x'.repeat(200)), null);
});

test('whitespace counts toward the length rather than being trimmed away', () => {
  // Trimming would silently change the password the user typed into a different one.
  assert.equal(validatePassword('        '), null);
});
