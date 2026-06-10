import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_TEXT_INPUT_LENGTH,
  MAX_TEXT_SAFETY_LENGTH,
  parsePositiveIntegerText,
  readSafeTextInput,
  sanitizeTerminalCell,
  sanitizeTerminalLine,
  sanitizeText
} from './text-safety';

const originalStringIterator = String.prototype[Symbol.iterator];

test('readSafeTextInput rejects oversized and control-bearing input', () => {
  assert.equal(readSafeTextInput(' nullbuilder ', { trim: true }), 'nullbuilder');
  assert.equal(readSafeTextInput('x'.repeat(MAX_TEXT_INPUT_LENGTH)), 'x'.repeat(MAX_TEXT_INPUT_LENGTH));
  assert.equal(readSafeTextInput('x'.repeat(MAX_TEXT_INPUT_LENGTH + 1)), null);
  assert.equal(readSafeTextInput('release/v1\x85hidden'), null);
  assert.equal(readSafeTextInput('release/v1\u202ehidden'), null);
  assert.equal(readSafeTextInput('release/v1\u2066hidden'), null);
  assert.equal(readSafeTextInput('release/v1\uD800hidden'), null);
  assert.equal(readSafeTextInput('release/v1\uDC00hidden'), null);
  assert.equal(readSafeTextInput('build-pr\x1b[31m\nsecret', { trim: true }), null);
});

test('readSafeTextInput rejects malformed runtime values without throwing type errors', () => {
  for (const value of [null, undefined, 17, true, { text: 'nullbuilder' }]) {
    assert.equal(readSafeTextInput(value), null);
  }
  assert.equal(readSafeTextInput('nullbuilder', { maxLength: '128' }), null);
  assert.equal(readSafeTextInput('nullbuilder', { maxLength: null }), null);
});

test('parsePositiveIntegerText accepts only safe positive base-10 integers', () => {
  assert.equal(parsePositiveIntegerText('1'), 1);
  assert.equal(parsePositiveIntegerText('42'), 42);
  assert.equal(parsePositiveIntegerText('0'), null);
  assert.equal(parsePositiveIntegerText('01'), null);
  assert.equal(parsePositiveIntegerText(' 42 '), null);
  assert.equal(parsePositiveIntegerText('1.5'), null);
  assert.equal(parsePositiveIntegerText('9007199254740992'), null);
  assert.equal(parsePositiveIntegerText('1'.repeat(100_000)), null);
});

test('parsePositiveIntegerText rejects malformed runtime values without throwing type errors', () => {
  for (const value of [null, undefined, 17, true, { value: '42' }]) {
    assert.equal(parsePositiveIntegerText(value), null);
  }
});

test('sanitizeText strips terminal controls and applies bounded fallback text', () => {
  assert.equal(sanitizeText('\x1b[31m\n\t', { maxLength: 10, fallback: 'fallback', trim: true }), 'fallback');
  assert.equal(sanitizeText('safe\x1b]0;title\x07 text', { maxLength: 64, trim: true }), 'safe text');
  assert.equal(sanitizeText('safe\u202espoof\u2069 text', { maxLength: 64, trim: true }), 'safe spoof  text');
  assert.equal(sanitizeText('safe\uD800spoof\uDC00 text', { maxLength: 64, trim: true }), 'safe spoof  text');
});

test('sanitizeText strips ANSI string control payloads', () => {
  const escOutput = sanitizeText(
    'start\x1bPprivate-dcs\x1b\\mid\x1bXprivate-sos\x1b\\pm\x1b^private-pm\x07apc\x1b_private-apc\x1b\\end',
    { maxLength: 128 }
  );
  const rawOutput = sanitizeText(
    'start\x90private-dcs\x9cmid\x98private-sos\x1b\\pm\x9eprivate-pm\x07apc\x9fprivate-apc\x9cend\x9dprivate-osc\x9cdone',
    { maxLength: 128 }
  );

  assert.equal(escOutput, 'startmidpmapcend');
  assert.equal(rawOutput, 'startmidpmapcenddone');
  assert.equal(escOutput.includes('private'), false);
  assert.equal(rawOutput.includes('private'), false);
});

test('sanitizeText strips C1 control sequence payloads', () => {
  const output = sanitizeText('safe\x9b31mred\x9b0m text', { maxLength: 64, trim: true });

  assert.equal(output, 'safered text');
  assert.equal(output.includes('31m'), false);
  assert.equal(output.includes('0m'), false);
  assert.equal(sanitizeText('safe\x1b[31', { maxLength: 64, trim: true }), 'safe');
  assert.equal(sanitizeText('safe\x9b31', { maxLength: 64, trim: true }), 'safe');
});

test('sanitizeTerminalLine truncates by code point without splitting surrogate pairs', () => {
  const output = sanitizeTerminalLine('🙂'.repeat(3000), 2048);

  assert.equal(Array.from(output).length, 2048);
  assert.match(output, /^🙂+\.\.\.$/u);
  assert.equal(output.includes('\uFFFD'), false);
});

test('sanitizeTerminalLine truncates without string iterators', () => {
  String.prototype[Symbol.iterator] = function stringIteratorShouldNotBeCalled(): ReturnType<
    typeof originalStringIterator
  > {
    throw new Error('String.prototype iterator should not be called.');
  };

  let output = '';
  try {
    output = sanitizeTerminalLine(`${'🙂'.repeat(4)}abcd`, 6);
  } finally {
    String.prototype[Symbol.iterator] = originalStringIterator;
  }

  assert.equal(output, '🙂🙂🙂...');
  assert.equal(output.includes('\uFFFD'), false);
});

test('sanitizeText normalizes unsafe max length values', () => {
  assert.equal(sanitizeText('secret', { maxLength: Number.NaN, fallback: 'fallback', trim: true }), 'fallback');
  assert.equal(sanitizeText('secret', { maxLength: '6', fallback: 'fallback', trim: true }), 'fallback');

  const output = sanitizeTerminalLine('x'.repeat(MAX_TEXT_SAFETY_LENGTH + 10), Number.POSITIVE_INFINITY);

  assert.equal(Array.from(output).length, MAX_TEXT_SAFETY_LENGTH);
  assert.equal(output.endsWith('...'), true);
});

test('sanitizeTerminalCell reuses line sanitization before cell truncation', () => {
  assert.equal(sanitizeTerminalCell('bad\x1b[31m\nvalue', 2048, 12), 'bad value');
  assert.equal(sanitizeTerminalCell('x'.repeat(20), 2048, 8), 'xxxxx...');
  assert.equal(sanitizeTerminalCell('unsafe', 2048, -1), '');
  assert.equal(sanitizeTerminalCell('unsafe', 2048, '8'), '');
});
