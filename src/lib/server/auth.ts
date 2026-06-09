import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { NullbuilderConfig } from './config';

export const AUTH_COOKIE = 'nullbuilder_auth';
export const AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;

const ALLOWED_CLOCK_SKEW_MS = 60_000;

export type LoginRateLimiterOptions = {
  windowMs: number;
  maxFailures: number;
  maxKeys: number;
  now?: () => number;
};

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

export class LoginRateLimiter {
  #attempts = new Map<string, LoginAttempt>();
  #now: () => number;

  constructor(private readonly options: LoginRateLimiterOptions) {
    this.#now = options.now ?? Date.now;
  }

  isAllowed(key: string): boolean {
    const now = this.#now();
    this.#prune(now);
    const attempt = this.#attempts.get(key);
    return !attempt || attempt.failures < this.options.maxFailures;
  }

  recordFailure(key: string): void {
    const now = this.#now();
    this.#prune(now);
    const current = this.#attempts.get(key);

    if (!current || current.resetAt <= now) {
      this.#attempts.set(key, {
        failures: 1,
        resetAt: now + this.options.windowMs
      });
      return;
    }

    current.failures += 1;
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }

  get size(): number {
    return this.#attempts.size;
  }

  #prune(now: number): void {
    for (const [key, attempt] of this.#attempts) {
      if (attempt.resetAt <= now) {
        this.#attempts.delete(key);
      }
    }

    while (this.#attempts.size > this.options.maxKeys) {
      const oldestKey = this.#attempts.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.#attempts.delete(oldestKey);
    }
  }
}

export function isAuthenticated(cookies: Cookies, config: NullbuilderConfig): boolean {
  if (!config.webToken) {
    return !config.token;
  }

  const cookie = cookies.get(AUTH_COOKIE);
  return Boolean(cookie && isSessionTokenMatch(cookie, config.webToken));
}

export function createSessionToken(secret: string, now = Date.now()): string {
  const issuedAt = now.toString(36);
  return `${issuedAt}.${sessionSignature(issuedAt, secret)}`;
}

export function isSessionTokenMatch(value: string, secret: string, now = Date.now()): boolean {
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return false;
  }

  const [issuedAt, signature] = parts;
  if (!/^[0-9a-z]+$/i.test(issuedAt)) {
    return false;
  }

  const timestamp = Number.parseInt(issuedAt, 36);

  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + ALLOWED_CLOCK_SKEW_MS ||
    now - timestamp > AUTH_MAX_AGE_SECONDS * 1000
  ) {
    return false;
  }

  return isTokenMatch(signature, sessionSignature(issuedAt, secret));
}

export function createCsrfToken(cookies: Cookies, config: NullbuilderConfig): string | null {
  if (!config.webToken) {
    return null;
  }

  const session = cookies.get(AUTH_COOKIE);
  if (!session || !isSessionTokenMatch(session, config.webToken)) {
    return null;
  }

  return createHmac('sha256', config.webToken).update(`csrf:${session}`).digest('hex');
}

export function isCsrfTokenMatch(value: FormDataEntryValue | null, cookies: Cookies, config: NullbuilderConfig): boolean {
  const expected = createCsrfToken(cookies, config);
  return typeof value === 'string' && Boolean(expected && isTokenMatch(value, expected));
}

export function isTokenMatch(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionSignature(issuedAt: string, secret: string): string {
  return createHmac('sha256', secret).update(issuedAt).digest('hex');
}
