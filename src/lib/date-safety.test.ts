import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseUtcTimestampMillis } from './date-safety';

test('parseUtcTimestampMillis accepts strict UTC timestamps', () => {
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56Z'), Date.UTC(2026, 5, 2, 12, 34, 56));
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56.789Z'), Date.UTC(2026, 5, 2, 12, 34, 56, 789));
  assert.equal(new Date(parseUtcTimestampMillis('0001-01-01T00:00:00Z') ?? Number.NaN).toISOString(), '0001-01-01T00:00:00.000Z');
});

test('parseUtcTimestampMillis rejects ambiguous local and offset timestamps', () => {
  for (const value of [
    '2026-06-02',
    '2026-06-02 12:34:56',
    '06/02/2026',
    '2026-06-02T12:34:56',
    '2026-06-02T12:34:56+00:00',
    'Tue, 02 Jun 2026 12:34:56 GMT'
  ]) {
    assert.equal(parseUtcTimestampMillis(value), null);
  }
});

test('parseUtcTimestampMillis rejects invalid calendar and unsafe text', () => {
  for (const value of [
    '2026-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00Z\nhidden',
    '2026-01-01T00:00:00Z'.padEnd(128, 'x'),
    ''
  ]) {
    assert.equal(parseUtcTimestampMillis(value), null);
  }
});

test('parseUtcTimestampMillis applies caller max length', () => {
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56Z', { maxLength: 19 }), null);
  assert.equal(
    parseUtcTimestampMillis('2026-06-02T12:34:56Z', { maxLength: 64 }),
    Date.UTC(2026, 5, 2, 12, 34, 56)
  );
});
