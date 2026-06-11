import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  hasUnsafeHttpUrlPathSyntax,
  hasEncodedTextControlCharacter,
  isCanonicalLoopbackHttpUrl,
  readSafeUrlText,
  safeHttpUrlText
} from './url-safety';

const originalNumberParseInt = Number.parseInt;
const originalUrl = globalThis.URL;

function restoreGlobalUrl(): void {
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: originalUrl
  });
}

test('readSafeUrlText rejects raw and encoded text controls', () => {
  assert.equal(
    readSafeUrlText('https://github.example.test/nullclaw/nullbuilder', { maxLength: 2048 }),
    'https://github.example.test/nullclaw/nullbuilder'
  );

  for (const value of [
    'https://github.example.test/nullclaw/nullbuilder\nsecret',
    'https://github.example.test/nullclaw/nullbuilder\u202esecret',
    'https://github.example.test/nullclaw/nullbuilder\ud800',
    'https://github.example.test/nullclaw/nullbuilder%0asecret',
    'https://github.example.test/nullclaw/nullbuilder%c2%85secret',
    'https://github.example.test/nullclaw/nullbuilder%e2%80%aesecret',
    'https://github.example.test/nullclaw/nullbuilder%E2%81%A6secret'
  ]) {
    assert.equal(readSafeUrlText(value, { maxLength: 2048 }), null);
  }
});

test('hasEncodedTextControlCharacter identifies percent-encoded text controls only', () => {
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions?query=check%20suite'), false);
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions%1b'), true);
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions%d8%9c'), true);
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions%e2%80%8f'), true);
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions%e2%80%aa'), true);
  assert.equal(hasEncodedTextControlCharacter('/nullclaw/nullbuilder/actions%e2%81%a9'), true);
});

test('safeHttpUrlText accepts HTTPS and canonical loopback-only HTTP URLs', () => {
  assert.equal(
    safeHttpUrlText('https://github.example.test/nullclaw/nullbuilder/actions?query=check%20suite', {
      maxLength: 2048
    }),
    'https://github.example.test/nullclaw/nullbuilder/actions?query=check%20suite'
  );
  assert.equal(
    safeHttpUrlText('http://localhost/nullclaw/nullbuilder', { maxLength: 2048 }),
    'http://localhost/nullclaw/nullbuilder'
  );
  assert.equal(
    safeHttpUrlText('http://localhost:1/nullclaw/nullbuilder', { maxLength: 2048 }),
    'http://localhost:1/nullclaw/nullbuilder'
  );
  assert.equal(
    safeHttpUrlText('http://127.255.255.255:65535/nullclaw/nullbuilder', { maxLength: 2048 }),
    'http://127.255.255.255:65535/nullclaw/nullbuilder'
  );
  assert.equal(
    safeHttpUrlText('http://[::1]:8080/nullclaw/nullbuilder', { maxLength: 2048 }),
    'http://[::1]:8080/nullclaw/nullbuilder'
  );

  for (const value of [
    '',
    'javascript:alert(1)',
    'mailto:security@example.test',
    'http://github.example.test/nullclaw/nullbuilder',
    'http://127.0.0.01/nullclaw/nullbuilder',
    'http://0177.0.0.1/nullclaw/nullbuilder',
    'http://[::2]/nullclaw/nullbuilder',
    'http://localhost:08080/nullclaw/nullbuilder',
    'http://localhost:00001/nullclaw/nullbuilder',
    'http://127.0.0.1:0/nullclaw/nullbuilder',
    'http://127.0.0.1:65536/nullclaw/nullbuilder',
    'http://127.0.0.1:99999/nullclaw/nullbuilder',
    'https://user:pass@github.example.test/nullclaw/nullbuilder',
    'https://github.example.test/nullclaw/nullbuilder bad',
    'https://github.example.test/nullclaw/nullbuilder"bad',
    'https://github.example.test/nullclaw//nullbuilder',
    'https://github.example.test/nullclaw/%2e%2e/secret',
    'https://github.example.test/nullclaw/nullbuilder%0asecret',
    'https://github.example.test/nullclaw/nullbuilder\u202esecret',
    42,
    null
  ]) {
    assert.equal(safeHttpUrlText(value, { maxLength: 2048 }), null);
  }
});

test('safeHttpUrlText parses with captured URL constructor', () => {
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    writable: true,
    value: class URLShouldNotBeCalled {
      constructor() {
        throw new Error('global URL constructor should not be called');
      }
    }
  });

  try {
    assert.equal(
      safeHttpUrlText('https://github.example.test/nullclaw/nullbuilder/actions', {
        maxLength: 2048
      }),
      'https://github.example.test/nullclaw/nullbuilder/actions'
    );
  } finally {
    restoreGlobalUrl();
  }
});

test('hasUnsafeHttpUrlPathSyntax rejects ambiguous raw path segments', () => {
  for (const value of [
    'https://github.example.test',
    'https://github.example.test/',
    'https://github.example.test/api/v3/',
    'https://github.example.test/api/v3?query=1',
    'https://github.example.test/api/v3#fragment'
  ]) {
    assert.equal(hasUnsafeHttpUrlPathSyntax(value), false, value);
  }

  for (const value of [
    'https://github.example.test/api//v3',
    'https://github.example.test/api/./v3',
    'https://github.example.test/api/../secret',
    'https://github.example.test/api/%2e/v3',
    'https://github.example.test/api/%2E%2e/secret',
    'https://github.example.test/api//secret?token=value',
    'https://github.example.test/api/%2e%2e/secret#fragment'
  ]) {
    assert.equal(hasUnsafeHttpUrlPathSyntax(value), true, value);
  }
});

test('isCanonicalLoopbackHttpUrl validates raw loopback syntax before URL normalization', () => {
  for (const value of [
    'http://localhost',
    'http://localhost:8080/path',
    'HTTP://LOCALHOST/path',
    'http://127.0.0.1',
    'http://127.255.255.255:65535/path',
    'http://[::1]/path'
  ]) {
    assert.equal(isCanonicalLoopbackHttpUrl(value), true, value);
  }

  for (const value of [
    'https://localhost',
    'http://github.example.test',
    'http://user@localhost',
    'http://localhost:0',
    'http://localhost:08080',
    'http://localhost:00001',
    'http://localhost:65536',
    'http://localhost:99999',
    'http://127.0.0.01',
    'http://0177.0.0.1',
    'http://127.0.0.256',
    'http://126.0.0.1',
    'http://[::2]',
    'http://::1'
  ]) {
    assert.equal(isCanonicalLoopbackHttpUrl(value), false, value);
  }
});

test('loopback port validation uses checked decimal parsing', () => {
  Number.parseInt = function parseIntShouldNotBeCalled(): never {
    throw new Error('Number.parseInt should not be called');
  };

  try {
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:1/path'), true);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:65535/path'), true);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:0/path'), false);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:00001/path'), false);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:65536/path'), false);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:99999/path'), false);
    assert.equal(isCanonicalLoopbackHttpUrl('http://localhost:123456/path'), false);
  } finally {
    Number.parseInt = originalNumberParseInt;
  }
});
