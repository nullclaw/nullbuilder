import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitizeTerminalCell, sanitizeTerminalLine, sanitizeText } from './text-safety';

test('sanitizeText strips terminal controls and applies bounded fallback text', () => {
  assert.equal(sanitizeText('\x1b[31m\n\t', { maxLength: 10, fallback: 'fallback', trim: true }), 'fallback');
  assert.equal(sanitizeText('safe\x1b]0;title\x07 text', { maxLength: 64, trim: true }), 'safe text');
});

test('sanitizeTerminalLine truncates by code point without splitting surrogate pairs', () => {
  const output = sanitizeTerminalLine('🙂'.repeat(3000), 2048);

  assert.equal(Array.from(output).length, 2048);
  assert.match(output, /^🙂+\.\.\.$/u);
  assert.equal(output.includes('\uFFFD'), false);
});

test('sanitizeTerminalCell reuses line sanitization before cell truncation', () => {
  assert.equal(sanitizeTerminalCell('bad\x1b[31m\nvalue', 2048, 12), 'bad value');
  assert.equal(sanitizeTerminalCell('x'.repeat(20), 2048, 8), 'xxxxx...');
});
