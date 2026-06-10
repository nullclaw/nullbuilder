import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applySecurityHeaders, securityHeaderEntries } from './security-headers';

const originalArrayIterator = Array.prototype[Symbol.iterator];

test('security headers set conservative browser boundaries', () => {
  const headers = new Headers({
    'Content-Security-Policy': "default-src 'self'"
  });

  applySecurityHeaders(headers);

  assert.equal(
    headers.get('Content-Security-Policy'),
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
  );
  assert.equal(headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(headers.get('Origin-Agent-Cluster'), '?1');
  assert.equal(headers.get('Permissions-Policy'), 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
});

test('security headers apply without array iterators', () => {
  const headers = new Headers();

  withGuardedArrayIterator(() => {
    applySecurityHeaders(headers);
  });

  assert.equal(headers.get('X-Frame-Options'), 'DENY');
});

test('security header policy is valid single-line header text', () => {
  const names = new Set<string>();

  for (const [name, value] of securityHeaderEntries()) {
    assert.equal(names.has(name.toLowerCase()), false);
    assert.match(name, /^[A-Za-z0-9-]+$/);
    assert.doesNotMatch(value, /[\r\n]/);
    names.add(name.toLowerCase());
  }
});

function withGuardedArrayIterator<T>(callback: () => T): T {
  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype[Symbol.iterator] should not be called');
  };

  try {
    return callback();
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }
}
