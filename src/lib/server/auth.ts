import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { NullbuilderConfig } from './config';
import { readSafeTextInput } from '../text-safety';
import { normalizeBoundedPositiveInteger } from './number-safety';

export const AUTH_COOKIE = 'nullbuilder_auth';
export const AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;
export const AUTH_COOKIE_DELETE_OPTIONS = {
  path: '/'
} as const;

const ALLOWED_CLOCK_SKEW_MS = 60_000;
const SESSION_SIGNATURE_LENGTH = 64;
const MAX_ISSUED_AT_LENGTH = Number.MAX_SAFE_INTEGER.toString(36).length;
const MAX_SESSION_TOKEN_LENGTH = MAX_ISSUED_AT_LENGTH + 1 + SESSION_SIGNATURE_LENGTH;
const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const DEFAULT_LOGIN_RATE_LIMIT_MAX_KEYS = 1000;
const MAX_LOGIN_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_RATE_LIMIT_FAILURES = 1000;
const MAX_LOGIN_RATE_LIMIT_KEYS = 100_000;
const MAX_LOGIN_RATE_LIMIT_KEY_LENGTH = 128;
const FALLBACK_LOGIN_RATE_LIMIT_KEY = 'unknown-client';

export type LoginRateLimiterOptions = {
  windowMs: number;
  maxFailures: number;
  maxKeys: number;
  now?: () => number;
};

export type AuthCookieOptions = {
  httpOnly: true;
  maxAge: number;
  path: '/';
  sameSite: 'strict';
  secure: boolean;
};

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

type SessionTokenParts = {
  issuedAt: string;
  signature: string;
  timestamp: number;
};

type NormalizedLoginRateLimiterOptions = {
  windowMs: number;
  maxFailures: number;
  maxKeys: number;
};

export class LoginRateLimiter {
  #attempts = new Map<string, LoginAttempt>();
  #options: NormalizedLoginRateLimiterOptions;
  #now: () => number;

  constructor(options: LoginRateLimiterOptions) {
    this.#options = normalizeLoginRateLimiterOptions(options);
    this.#now = options.now ?? Date.now;
  }

  isAllowed(key: string): boolean {
    const normalizedKey = normalizeLoginRateLimitKey(key);
    const now = this.#nowMs();
    this.#prune(now);
    const attempt = this.#attempts.get(normalizedKey);
    return !attempt || attempt.failures < this.#options.maxFailures;
  }

  recordFailure(key: string): void {
    const normalizedKey = normalizeLoginRateLimitKey(key);
    const now = this.#nowMs();
    this.#prune(now);
    const current = this.#attempts.get(normalizedKey);

    if (!current || current.resetAt <= now) {
      this.#attempts.set(normalizedKey, {
        failures: 1,
        resetAt: now + this.#options.windowMs
      });
      this.#prune(now);
      return;
    }

    current.failures += 1;
  }

  clear(key: string): void {
    this.#attempts.delete(normalizeLoginRateLimitKey(key));
  }

  get size(): number {
    return this.#attempts.size;
  }

  #nowMs(): number {
    const now = this.#now();
    return Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();
  }

  #prune(now: number): void {
    for (const [key, attempt] of this.#attempts) {
      if (attempt.resetAt <= now) {
        this.#attempts.delete(key);
      }
    }

    while (this.#attempts.size > this.#options.maxKeys) {
      const oldestKey = this.#attempts.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.#attempts.delete(oldestKey);
    }
  }
}

function normalizeLoginRateLimitKey(value: string): string {
  const safe = readSafeTextInput(value, {
    maxLength: MAX_LOGIN_RATE_LIMIT_KEY_LENGTH,
    trim: true
  });
  return safe || FALLBACK_LOGIN_RATE_LIMIT_KEY;
}

function normalizeLoginRateLimiterOptions(options: LoginRateLimiterOptions): NormalizedLoginRateLimiterOptions {
  return {
    windowMs: normalizeBoundedPositiveInteger(
      options.windowMs,
      DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS,
      MAX_LOGIN_RATE_LIMIT_WINDOW_MS
    ),
    maxFailures: normalizeBoundedPositiveInteger(
      options.maxFailures,
      DEFAULT_LOGIN_RATE_LIMIT_MAX_FAILURES,
      MAX_LOGIN_RATE_LIMIT_FAILURES
    ),
    maxKeys: normalizeBoundedPositiveInteger(
      options.maxKeys,
      DEFAULT_LOGIN_RATE_LIMIT_MAX_KEYS,
      MAX_LOGIN_RATE_LIMIT_KEYS
    )
  };
}

export function isAuthenticated(cookies: Cookies, config: NullbuilderConfig): boolean {
  if (!config.webToken) {
    return !config.token;
  }

  const cookie = cookies.get(AUTH_COOKIE);
  return Boolean(cookie && isSessionTokenMatch(cookie, config.webToken));
}

export function authCookieOptions(isProduction: boolean): AuthCookieOptions {
  return {
    httpOnly: true,
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'strict',
    secure: isProduction
  };
}

export function createSessionToken(secret: string, now = Date.now()): string {
  const issuedAt = now.toString(36);
  return `${issuedAt}.${sessionSignature(issuedAt, secret)}`;
}

export function isSessionTokenMatch(value: string, secret: string, now = Date.now()): boolean {
  const token = parseSessionToken(value);

  if (
    !token ||
    token.timestamp > now + ALLOWED_CLOCK_SKEW_MS ||
    now - token.timestamp > AUTH_MAX_AGE_SECONDS * 1000
  ) {
    return false;
  }

  return isTokenMatch(token.signature, sessionSignature(token.issuedAt, secret));
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
  if (value.length !== expected.length) {
    return false;
  }

  const left = Buffer.from(value);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
}

function parseSessionToken(value: string): SessionTokenParts | null {
  if (value.length > MAX_SESSION_TOKEN_LENGTH) {
    return null;
  }

  const separator = value.indexOf('.');
  if (separator <= 0 || separator !== value.lastIndexOf('.')) {
    return null;
  }

  const issuedAt = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!isIssuedAtTokenPart(issuedAt) || !isSignatureTokenPart(signature)) {
    return null;
  }

  const timestamp = Number.parseInt(issuedAt, 36);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return null;
  }

  return {
    issuedAt,
    signature,
    timestamp
  };
}

function isIssuedAtTokenPart(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ISSUED_AT_LENGTH && /^[0-9a-z]+$/.test(value);
}

function isSignatureTokenPart(value: string): boolean {
  return value.length === SESSION_SIGNATURE_LENGTH && /^[0-9a-f]+$/.test(value);
}

function sessionSignature(issuedAt: string, secret: string): string {
  return createHmac('sha256', secret).update(issuedAt).digest('hex');
}
