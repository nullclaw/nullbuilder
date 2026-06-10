import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import type { NullbuilderConfig } from './config';
import { readSafeTextInput } from '../text-safety';
import {
  isSafeNonNegativeInteger,
  normalizeBoundedPositiveInteger,
  saturatingSafeIntegerAdd
} from '../number-safety';

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
const MAX_TOKEN_COMPARE_BYTES = 4096;
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

export type AuthContext = {
  authenticated: boolean;
  csrfToken: string | null;
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
  #attemptKeys: string[] = [];
  #attemptKeyHead = 0;
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
      this.#rememberAttempt(normalizedKey, {
        failures: 1,
        resetAt: now + this.#options.windowMs
      });
      this.#prune(now);
      return;
    }

    current.failures = nextFailureCount(current.failures, this.#options.maxFailures);
  }

  clear(key: string): void {
    this.#deleteAttempt(normalizeLoginRateLimitKey(key));
  }

  get size(): number {
    return this.#attempts.size;
  }

  #nowMs(): number {
    return safeClockMillis(this.#now()) ?? safeClockMillis(Date.now()) ?? 0;
  }

  #prune(now: number): void {
    let writeIndex = 0;
    for (let readIndex = this.#attemptKeyHead; readIndex < this.#attemptKeys.length; readIndex += 1) {
      const key = this.#attemptKeys[readIndex];
      const attempt = this.#attempts.get(key);
      if (!attempt || attempt.resetAt <= now) {
        this.#attempts.delete(key);
        continue;
      }

      this.#attemptKeys[writeIndex] = key;
      writeIndex += 1;
    }
    this.#attemptKeys.length = writeIndex;
    this.#attemptKeyHead = 0;

    while (this.#attempts.size > this.#options.maxKeys) {
      const oldestKey = this.#takeOldestAttemptKey();
      if (oldestKey === undefined) {
        return;
      }
      this.#attempts.delete(oldestKey);
    }
  }

  #rememberAttempt(key: string, attempt: LoginAttempt): void {
    if (!this.#attempts.has(key)) {
      this.#attemptKeys.push(key);
    }
    this.#attempts.set(key, attempt);
  }

  #deleteAttempt(key: string): void {
    if (this.#attempts.delete(key)) {
      this.#removeAttemptKey(key);
    }
  }

  #removeAttemptKey(key: string): void {
    let removed = false;
    let writeIndex = 0;
    for (let readIndex = this.#attemptKeyHead; readIndex < this.#attemptKeys.length; readIndex += 1) {
      const attemptKey = this.#attemptKeys[readIndex];
      if (!removed && attemptKey === key) {
        removed = true;
        continue;
      }

      this.#attemptKeys[writeIndex] = attemptKey;
      writeIndex += 1;
    }
    this.#attemptKeys.length = writeIndex;
    this.#attemptKeyHead = 0;
  }

  #takeOldestAttemptKey(): string | undefined {
    while (this.#attemptKeyHead < this.#attemptKeys.length) {
      const key = this.#attemptKeys[this.#attemptKeyHead];
      this.#attemptKeyHead += 1;
      if (this.#attempts.has(key)) {
        return key;
      }
    }

    this.#attemptKeys.length = 0;
    this.#attemptKeyHead = 0;
    return undefined;
  }
}

function normalizeLoginRateLimitKey(value: string): string {
  const safe = readSafeTextInput(value, {
    maxLength: MAX_LOGIN_RATE_LIMIT_KEY_LENGTH,
    trim: true
  });
  return safe || FALLBACK_LOGIN_RATE_LIMIT_KEY;
}

function safeClockMillis(value: number): number | null {
  const timestamp = Math.floor(value);
  return isSafeNonNegativeInteger(timestamp) ? timestamp : null;
}

function nextFailureCount(value: number, maxFailures: number): number {
  return Math.min(saturatingSafeIntegerAdd(value, 1), maxFailures);
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

  return Boolean(validSessionCookie(cookies, config.webToken));
}

export function resolveAuthContext(cookies: Cookies, config: NullbuilderConfig): AuthContext {
  if (!config.webToken) {
    return {
      authenticated: !config.token,
      csrfToken: null
    };
  }

  const session = validSessionCookie(cookies, config.webToken);
  if (!session) {
    return {
      authenticated: false,
      csrfToken: null
    };
  }

  return {
    authenticated: true,
    csrfToken: createCsrfTokenForSession(session, config.webToken)
  };
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
  const timestamp = normalizeSessionTimestamp(now);
  if (timestamp === null) {
    throw new Error('Invalid session timestamp.');
  }

  const issuedAt = timestamp.toString(36);
  return `${issuedAt}.${sessionSignature(issuedAt, secret)}`;
}

export function isSessionTokenMatch(value: string, secret: string, now = Date.now()): boolean {
  const token = parseSessionToken(value);
  const currentTimestamp = normalizeSessionTimestamp(now);

  if (
    !token ||
    currentTimestamp === null ||
    token.timestamp > currentTimestamp + ALLOWED_CLOCK_SKEW_MS ||
    currentTimestamp - token.timestamp > AUTH_MAX_AGE_SECONDS * 1000
  ) {
    return false;
  }

  return isTokenMatch(token.signature, sessionSignature(token.issuedAt, secret));
}

export function createCsrfToken(cookies: Cookies, config: NullbuilderConfig): string | null {
  return resolveAuthContext(cookies, config).csrfToken;
}

export function isCsrfTokenMatch(value: FormDataEntryValue | null, cookies: Cookies, config: NullbuilderConfig): boolean {
  const expected = createCsrfToken(cookies, config);
  return typeof value === 'string' && Boolean(expected && isTokenMatch(value, expected));
}

export function isTokenMatch(value: string, expected: string): boolean {
  if (value.length > MAX_TOKEN_COMPARE_BYTES || expected.length > MAX_TOKEN_COMPARE_BYTES) {
    return false;
  }

  const valueBytes = Buffer.byteLength(value);
  const expectedBytes = Buffer.byteLength(expected);
  if (valueBytes !== expectedBytes || valueBytes > MAX_TOKEN_COMPARE_BYTES) {
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

function normalizeSessionTimestamp(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  const timestamp = Math.floor(value);
  return isSafeNonNegativeInteger(timestamp) ? timestamp : null;
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

function validSessionCookie(cookies: Cookies, secret: string): string | null {
  const session = cookies.get(AUTH_COOKIE);
  return session && isSessionTokenMatch(session, secret) ? session : null;
}

function createCsrfTokenForSession(session: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${session}`).digest('hex');
}
