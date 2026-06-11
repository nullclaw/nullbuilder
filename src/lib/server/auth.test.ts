import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { afterEach, test } from 'node:test';
import type { Cookies } from '@sveltejs/kit';
import { readConfig } from './config';
import {
  AUTH_COOKIE,
  AUTH_COOKIE_DELETE_OPTIONS,
  AUTH_MAX_AGE_SECONDS,
  authCookieOptions,
  authCookieOptionsForRuntimeEnv,
  createCsrfToken,
  createSessionToken,
  isAuthenticated,
  isCsrfTokenMatch,
  isSessionTokenMatch,
  isTokenMatch,
  LoginRateLimiter,
  resolveAuthContext
} from './auth';

const originalMapKeys = Map.prototype.keys;
const originalMapIterator = Map.prototype[Symbol.iterator];
const originalArrayPush = Array.prototype.push;
const originalNumberParseInt = Number.parseInt;
const originalBufferByteLength = Buffer.byteLength;
const originalBufferFrom = Buffer.from;

afterEach(() => {
  restoreArrayPush();
  restoreMapIteration();
  restoreNumberParsing();
  restoreBufferIntrinsics();
});

function cookiesWith(value?: string): Cookies {
  return {
    get: (name: string) => (name === AUTH_COOKIE ? value : undefined)
  } as Cookies;
}

function rejectMapIteration(): void {
  Map.prototype.keys = function mapKeysShouldNotBeCalled(): ReturnType<Map<unknown, unknown>['keys']> {
    throw new Error('Map.prototype.keys should not be called');
  } as typeof originalMapKeys;
  Map.prototype[Symbol.iterator] =
    function mapIteratorShouldNotBeCalled(): ReturnType<Map<unknown, unknown>[typeof Symbol.iterator]> {
      throw new Error('Map.prototype[Symbol.iterator] should not be called');
    } as typeof originalMapIterator;
}

function restoreMapIteration(): void {
  Map.prototype.keys = originalMapKeys;
  Map.prototype[Symbol.iterator] = originalMapIterator;
}

function restoreArrayPush(): void {
  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value: originalArrayPush
  });
}

function restoreNumberParsing(): void {
  Number.parseInt = originalNumberParseInt;
}

function restoreBufferIntrinsics(): void {
  Buffer.byteLength = originalBufferByteLength;
  Buffer.from = originalBufferFrom;
}

test('session tokens validate signature and expiry', () => {
  const issuedAt = 1_000_000;
  const token = createSessionToken('secret', issuedAt);
  const [, signature] = token.split('.');

  assert.equal(isSessionTokenMatch(token, 'secret', issuedAt), true);
  assert.equal(isSessionTokenMatch(createSessionToken('secret', issuedAt + 0.9), 'secret', issuedAt), true);
  assert.equal(isSessionTokenMatch(token, 'wrong', issuedAt), false);
  assert.equal(isSessionTokenMatch(`bad!.${signature}`, 'secret', issuedAt), false);
  assert.equal(isSessionTokenMatch(token, 'secret', issuedAt + AUTH_MAX_AGE_SECONDS * 1000 + 1), false);
});

test('session tokens reject unsafe clocks before checking expiry', () => {
  const token = createSessionToken('secret', 1_000_000);

  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isSessionTokenMatch(token, 'secret', now), false);
  }
});

test('session token creation rejects unsafe issue timestamps', () => {
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createSessionToken('secret', now),
      (error: unknown) => error instanceof Error && error.message === 'Invalid session timestamp.'
    );
  }
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

test('session tokens parse issued-at timestamps without Number.parseInt', () => {
  const token = createSessionToken('secret', Number.MAX_SAFE_INTEGER);

  Number.parseInt = function parseIntShouldNotBeCalled(): never {
    throw new Error('Number.parseInt should not be called');
  };

  try {
    assert.equal(isSessionTokenMatch(token, 'secret', Number.MAX_SAFE_INTEGER), true);
    assert.equal(isSessionTokenMatch(`${'z'.repeat(11)}.${'f'.repeat(64)}`, 'secret', Number.MAX_SAFE_INTEGER), false);
  } finally {
    restoreNumberParsing();
  }
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

test('auth cookie options derive secure policy from literal production runtime env', () => {
  assert.equal(authCookieOptionsForRuntimeEnv('production').secure, true);
  assert.equal(authCookieOptionsForRuntimeEnv('development').secure, false);
  assert.equal(authCookieOptionsForRuntimeEnv(' production ').secure, false);
  assert.equal(authCookieOptionsForRuntimeEnv('PRODUCTION').secure, false);
  assert.equal(authCookieOptionsForRuntimeEnv(undefined).secure, false);
  assert.equal(authCookieOptionsForRuntimeEnv({ toString: () => 'production' }).secure, false);
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

test('auth context resolves authentication and csrf from one valid web session', () => {
  const config = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder',
    NULLBUILDER_WEB_TOKEN: 'web-secret'
  });
  const session = createSessionToken('web-secret');
  const unauthenticated = resolveAuthContext(cookiesWith(undefined), config);
  const authenticated = resolveAuthContext(cookiesWith(session), config);

  assert.deepEqual(unauthenticated, {
    authenticated: false,
    csrfToken: null
  });
  assert.equal(authenticated.authenticated, true);
  assert.equal(typeof authenticated.csrfToken, 'string');
  assert.equal(authenticated.csrfToken, createCsrfToken(cookiesWith(session), config));

  const anonymousConfig = readConfig({
    NULLBUILDER_REPOS: 'nullbuilder'
  });
  assert.deepEqual(resolveAuthContext(cookiesWith(undefined), anonymousConfig), {
    authenticated: true,
    csrfToken: null
  });
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

  assert.equal(isTokenMatch('\u043a\u043b\u044e\u0447', '\u043a\u043b\u044e\u0447'), true);
  assert.equal(isTokenMatch('a'.repeat(65), expected), false);
  assert.equal(isTokenMatch(`${'a'.repeat(63)}é`, expected), false);
  assert.equal(isTokenMatch('a'.repeat(4097), 'a'.repeat(4097)), false);
  assert.equal(isTokenMatch('b'.repeat(64), expected), false);
});

test('token comparison rejects oversized strings before byte-length work', () => {
  try {
    Buffer.byteLength = (() => {
      throw new Error('byteLength should not be called for oversized token strings');
    }) as typeof Buffer.byteLength;

    assert.equal(isTokenMatch('a'.repeat(4097), 'a'.repeat(64)), false);
    assert.equal(isTokenMatch('a'.repeat(64), 'a'.repeat(4097)), false);
  } finally {
    restoreBufferIntrinsics();
  }
});

test('token comparison uses captured buffer intrinsics', () => {
  Buffer.byteLength = (() => {
    throw new Error('Buffer.byteLength should not be called');
  }) as typeof Buffer.byteLength;
  Buffer.from = (() => {
    throw new Error('Buffer.from should not be called');
  }) as typeof Buffer.from;

  assert.equal(isTokenMatch('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(isTokenMatch('b'.repeat(64), 'a'.repeat(64)), false);
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

test('login rate limiter falls back from unsafe provider clocks', () => {
  const originalDateNow = Date.now;
  let fallbackNow = 10_000;
  Date.now = () => fallbackNow;

  try {
    const limiter = new LoginRateLimiter({
      windowMs: 1000,
      maxFailures: 1,
      maxKeys: 10,
      now: () => Number.MAX_SAFE_INTEGER + 1
    });

    limiter.recordFailure('client');
    assert.equal(limiter.isAllowed('client'), false);

    fallbackNow += 1001;
    assert.equal(limiter.isAllowed('client'), true);
    assert.equal(limiter.size, 0);
  } finally {
    Date.now = originalDateNow;
  }
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

test('login rate limiter prunes and bounds attempts without Map iteration', () => {
  let now = 10_000;
  const limiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 1,
    maxKeys: 2,
    now: () => now
  });

  rejectMapIteration();
  try {
    limiter.recordFailure('client-a');
    limiter.recordFailure('client-b');
    limiter.recordFailure('client-c');

    assert.equal(limiter.size, 2);
    assert.equal(limiter.isAllowed('client-a'), true);
    assert.equal(limiter.size, 2);

    now += 1001;
    assert.equal(limiter.isAllowed('client-b'), true);
    assert.equal(limiter.size, 0);
  } finally {
    restoreMapIteration();
  }
});

test('login rate limiter records attempts without global array push hooks', () => {
  const limiter = new LoginRateLimiter({
    windowMs: 1000,
    maxFailures: 1,
    maxKeys: 2,
    now: () => 10_000
  });
  let pushCalls = 0;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('Array.prototype.push should not be called');
    }
  });

  try {
    limiter.recordFailure('client-a');
    limiter.recordFailure('client-b');
    limiter.recordFailure('client-c');
  } finally {
    restoreArrayPush();
  }

  assert.equal(pushCalls, 0);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.isAllowed('client-a'), true);
  assert.equal(limiter.isAllowed('client-c'), false);
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
