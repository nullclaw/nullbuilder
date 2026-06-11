import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseUtcTimestampMillis, safeUtcTimestampText } from './date-safety';

const originalDate = Date;
const originalNumber = Number;

test('parseUtcTimestampMillis accepts strict UTC timestamps', () => {
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56Z'), Date.UTC(2026, 5, 2, 12, 34, 56));
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56.7Z'), Date.UTC(2026, 5, 2, 12, 34, 56, 700));
  assert.equal(parseUtcTimestampMillis('2026-06-02T12:34:56.78Z'), Date.UTC(2026, 5, 2, 12, 34, 56, 780));
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

test('parseUtcTimestampMillis handles malformed runtime values and options safely', () => {
  assert.equal(parseUtcTimestampMillis(42), null);
  assert.equal(parseUtcTimestampMillis({ value: '2026-06-02T12:34:56Z' }), null);
  assert.equal(
    parseUtcTimestampMillis('2026-06-02T12:34:56Z', { maxLength: '64' }),
    Date.UTC(2026, 5, 2, 12, 34, 56)
  );
  assert.equal(
    parseUtcTimestampMillis('2026-06-02T12:34:56Z', { maxLength: Number.NaN }),
    Date.UTC(2026, 5, 2, 12, 34, 56)
  );
});

test('parseUtcTimestampMillis parses timestamp fields with captured runtime intrinsics', () => {
  const expected = Date.UTC(2026, 5, 2, 12, 34, 56, 789);
  const expectedWithoutMillis = Date.UTC(2026, 5, 2, 12, 34, 56);
  const throwingDate = new Proxy(originalDate, {
    apply(): never {
      throw new Error('Date constructor should not be called');
    },
    construct(): never {
      throw new Error('Date constructor should not be called');
    }
  }) as DateConstructor;
  globalThis.Number = new Proxy(originalNumber, {
    apply(): never {
      throw new Error('Number constructor should not be called');
    },
    construct(): never {
      throw new Error('Number constructor should not be called');
    },
    get(target, property, receiver) {
      if (property === 'isFinite') {
        throw new Error('Number.isFinite should not be read');
      }

      return Reflect.get(target, property, receiver);
    }
  });
  globalThis.Date = throwingDate;

  let parsedWithMillis: number | null = null;
  let parsedWithoutMillis: number | null = null;

  try {
    parsedWithMillis = parseUtcTimestampMillis('2026-06-02T12:34:56.789Z');
    parsedWithoutMillis = parseUtcTimestampMillis('2026-06-02T12:34:56Z');
  } finally {
    globalThis.Date = originalDate;
    globalThis.Number = originalNumber;
  }

  assert.equal(parsedWithMillis, expected);
  assert.equal(parsedWithoutMillis, expectedWithoutMillis);
});

test('safeUtcTimestampText returns only strict UTC timestamp text', () => {
  assert.equal(safeUtcTimestampText('2026-06-02T12:34:56Z'), '2026-06-02T12:34:56Z');
  assert.equal(safeUtcTimestampText('2026-06-02T12:34:56.789Z'), '2026-06-02T12:34:56.789Z');
  assert.equal(safeUtcTimestampText('2026-06-02T12:34:56+00:00'), '');
  assert.equal(safeUtcTimestampText('2026-06-02T12:34:56Z\nhidden'), '');
  assert.equal(safeUtcTimestampText('2026-06-02T12:34:56Z', { maxLength: 19 }), '');
  assert.equal(safeUtcTimestampText(42), '');
});
