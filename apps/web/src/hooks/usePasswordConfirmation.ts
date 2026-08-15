'use client';

import { useMemo, useState } from 'react';

/**
 * Shared state for a "type it twice" password field.
 *
 * A password input hides what you typed, so a slipped key produces an account you can't get back
 * into — and on the admin screens, one you've locked someone *else* out of. Confirming catches it
 * while the user is still on the page.
 *
 * The three screens that set passwords use different markup (the auth pages are raw Tailwind, the
 * dashboard uses the design system), so this owns the logic and each screen renders its own
 * inputs.
 */

interface Options {
  /** Mirrors whatever the API enforces, so the user isn't told "too short" only after submitting. */
  minLength?: number;
  /**
   * For admin screens where an empty field means "leave the existing password alone". Validation
   * is skipped entirely while both fields are blank.
   */
  optional?: boolean;
}

export interface PasswordConfirmation {
  password: string;
  confirmPassword: string;
  setPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  /**
   * The problem to show the user, or null. Held back until the confirm field has been typed in, so
   * the form doesn't shout "passwords do not match" at someone who is still on the first field.
   */
  error: string | null;
  /** True when the pair is safe to submit. */
  isValid: boolean;
  /** Clears both fields — call after a successful submit so a password isn't left in the DOM. */
  reset: () => void;
}

export function usePasswordConfirmation({ minLength = 8, optional = false }: Options = {}): PasswordConfirmation {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const untouched = optional && password === '' && confirmPassword === '';

  const error = useMemo(() => {
    if (untouched) return null;
    if (password.length > 0 && password.length < minLength) {
      return `Password must be at least ${minLength} characters`;
    }
    // Only complain about a mismatch once there is something to compare against.
    if (confirmPassword.length > 0 && password !== confirmPassword) {
      return 'The two passwords do not match';
    }
    return null;
  }, [password, confirmPassword, minLength, untouched]);

  const isValid = untouched || (password.length >= minLength && password === confirmPassword);

  return {
    password,
    confirmPassword,
    setPassword,
    setConfirmPassword,
    error,
    isValid,
    reset: () => {
      setPassword('');
      setConfirmPassword('');
    },
  };
}
