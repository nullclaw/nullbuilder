import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { readConfig } from './config';
import {
  AUTH_COOKIE,
  AUTH_COOKIE_DELETE_OPTIONS,
  AUTH_MAX_AGE_SECONDS,
  authCookieOptions,
  createCsrfToken,
  createSessionToken,
  isAuthenticated,
  isCsrfTokenMatch,
  isSessionTokenMatch,
  isTokenMatch,
  LoginRateLimiter
} from './auth';

function cookiesWith(value?: string): Cookies {
  return {
    get: (name: string) => (name === AUTH_COOKIE ? value : undefined)
  } as Cookies;
}

test('session tokens validate signature and expiry', () => {
  const issuedAt = 1_000_000;
  const token = createSessionToken('secret', issuedAt);
  const [, signature] = token.split('.');

  assert.equal(isSessionTokenMatch(token, 'secret', issuedAt), true);
  assert.equal(isSessionTokenMatch(token, 'wrong', issuedAt), false);
  assert.equal(isSessionTokenMatch(`bad!.${signature}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(token, 'secret', issuedAt + AUTH_MAX_AGE_SECONDS * 1000 + 1), false);
});

test('session tokens reject malformed bounded parts before matching signatures', () => {
  const issuedAt = 1_000_000;
  const token = createSessionToken('secret', issuedAt);
  const [timestamp, signature] = token.split('.');

  assert.equal(isSessionTokenMatch(`${timestamp.toUpperCase()}.${signature}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${'z'.repeat(12)}.${signature}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${timestamp}.${'f'.repeat(63)}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${timestamp}.${'f'.repeat(65)}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${timestamp}.${'g'.repeat(64)}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${timestamp}.${signature}.extra`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(`${timestamp}${'.x'.repeat(10_000)}`, 'secret', issuedAt), false);
});

test('auth cookie options keep session cookie policy centralized', () => {
  assert.deepEqual(authCookieOptions(true), {
    httpOnly: true,
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'strict',
    secure: true
  });
  assert.deepEqual(authCookieOptions(false), {
    httpOnly: true,
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'strict',
    secure: false
  });
  assert.deepEqual(AUTH_COOKIE_DELETE_OPTIONS, {
    path: '/'
  });
});

test('authentication requires a valid web token session when token-backed data is configured', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_GITHUB_TOKEN: 'github-token',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const session = createSessionToken('web-secret');

  assert.equal(isAuthenticated(cookiesWith(undefined), config), false);
  assert.equal(isAuthenticated(cookiesWith(session), config), true);
});

test('csrf token is tied to a valid session cookie', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const session = createSessionToken('web-secret');
  const cookies = cookiesWith(session);
  const csrfToken = createCsrfToken(cookies, config);

  assert.equal(typeof csrfToken, 'string');
  assert.equal(isCsrfTokenMatch(csrfToken, cookies, config), true);
  assert.equal(isCsrfTokenMatch('bad-token', cookies, config), false);
});

test('token comparison rejects malformed values before constant-time comparison', () => {
  const expected = 'a'.repeat(64);

  assert.equal(isTokenMatch('a'.repeat(65), expected), false);
  assert.equal(isTokenMatch(`${'a'.repeat(63)}é`, expected), false);
  assert.equal(isTokenMatch('b'.repeat(64), expected), false);
});

test('login rate limiter blocks repeated failures and prunes old attempts', () => {
  let now = 10_000;
  const limiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 2,
    maxKeys: 10,
    now: () => now
  });

  assert.equal(limiter.isAllowed('client'), true);
  limiter.recordFailure('client');
  assert.equal(limiter.isAllowed('client'), true);
  limiter.recordFailure('client');
  assert.equal(limiter.isAllowed('client'), false);

  now += 1001;
  assert.equal(limiter.isAllowed('client'), true);
  assert.equal(limiter.size, 0);
});

test('login rate limiter bounds distinct failed clients immediately', () => {
  const limiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 2,
    maxKeys: 2,
    now: () => 10_000
  });

  limiter.recordFailure('client-a');
  limiter.recordFailure('client-b');
  limiter.recordFailure('client-c');

  assert.equal(limiter.size, 2);
  assert.equal(limiter.isAllowed('client-a'), true);
  assert.equal(limiter.size, 2);
});

test('login rate limiter normalizes unsafe client keys before storage', () => {
  const limiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 1,
    maxKeys: 10,
    now: () => 10_000
  });

  limiter.recordFailure(' client ');
  assert.equal(limiter.isAllowed('client'), false);
  limiter.clear('client');
  assert.equal(limiter.isAllowed(' client '), true);

  limiter.recordFailure('x'.repeat(10_000));
  assert.equal(limiter.size, 1);
  assert.equal(limiter.isAllowed('bad\nclient'), false);
  limiter.clear('bad\x1b[31mclient');
  assert.equal(limiter.isAllowed('x'.repeat(10_000)), true);
  assert.equal(limiter.size, 0);
});

test('login rate limiter normalizes unsafe numeric options', () => {
  let now = 10_000;
  const limiter = new LoginRateLimiter({
    windowMs: -1,
    maxFailures: Number.NaN,
    maxKeys: Number.NaN,
    now: () => now
  });

  for (let index = 0; index < 4; index += 1) {
    limiter.recordFailure('client');
    assert.equal(limiter.isAllowed('client'), true);
  }

  limiter.recordFailure('client');
  assert.equal(limiter.isAllowed('client'), false);

  now += 1000;
  assert.equal(limiter.isAllowed('client'), false);

  now += 15 * 60 * 1000;
  assert.equal(limiter.isAllowed('client'), true);

  const keyLimiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 2,
    maxKeys: Number.NaN,
    now: () => 10_000
  });

  for (let index = 0; index <= 1000; index += 1) {
    keyLimiter.recordFailure(`client-${index}`);
  }

  assert.equal(keyLimiter.size, 1000);
});
