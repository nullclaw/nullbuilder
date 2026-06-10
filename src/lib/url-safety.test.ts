import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hasEncodedTextControlCharacter, readSafeUrlText, safeHttpUrlText } from './url-safety';

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

test('safeHttpUrlText accepts only credential-free HTTP URLs', () => {
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

  for (const value of [
    '',
    'javascript:alert(1)',
    'mailto:security@example.test',
    'https://user:pass@github.example.test/nullclaw/nullbuilder',
    'https://github.example.test/nullclaw/nullbuilder bad',
    'https://github.example.test/nullclaw/nullbuilder"bad',
    'https://github.example.test/nullclaw/nullbuilder%0asecret',
    'https://github.example.test/nullclaw/nullbuilder\u202esecret',
    42,
    null
  ]) {
    assert.equal(safeHttpUrlText(value, { maxLength: 2048 }), null);
  }
});
