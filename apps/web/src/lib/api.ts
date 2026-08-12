/**
 * Small fetch wrapper shared by the dashboard components.
 *
 * Every panel used to repeat the same block: fetch, parse JSON, check `res.ok`,
 * dig `data.error` out of the body, then fall back to a generic network message.
 * Getting that subtly wrong is why some panels used to fail silently.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Pulls the most useful message out of an error body, whatever shape it has. */
function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  if (typeof body === 'string' && body.trim()) return body;
  return `Request failed (HTTP ${status})`;
}

/**
 * Performs a request and resolves with the parsed body, or throws an `ApiError`
 * carrying the server's own message so callers can hand it straight to a toast.
 */
export async function apiRequest<T = any>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A rejected fetch means the request never landed — offline, DNS, CORS, aborted.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  // 204 and empty bodies are legitimate successes with nothing to parse.
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) throw new ApiError(messageFromBody(body, res.status), res.status);
  return body as T;
}

/** POSTs JSON and returns the parsed response. */
export function apiPost<T = any>(url: string, payload: unknown, init?: RequestInit): Promise<T> {
  return apiRequest<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...init,
  });
}

/** Normalises anything thrown in a catch block into a displayable string. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

/** Minecraft usernames: 3-16 characters, letters, digits or underscore. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,16}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_PATTERN.test(name);
}

export const USERNAME_HINT = 'Usernames must be 3-16 letters, digits or underscores.';
