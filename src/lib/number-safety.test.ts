import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  normalizeBoundedNonNegativeInteger,
  normalizeBoundedPositiveInteger,
  safeNonNegativeInteger,
  saturatingSafeIntegerAdd
} from './number-safety';

const originalNumber = Number;
const originalMathFloor = Math.floor;
const originalMathMax = Math.max;
const originalMathMin = Math.min;

test('safe integer helpers classify external numeric values', () => {
  assert.equal(isSafePositiveInteger(1), true);
  assert.equal(isSafePositiveInteger(0), false);
  assert.equal(isSafePositiveInteger(1.5), false);
  assert.equal(isSafePositiveInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isSafePositiveInteger('1'), false);

  assert.equal(isSafeNonNegativeInteger(0), true);
  assert.equal(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isSafeNonNegativeInteger(-1), false);
  assert.equal(isSafeNonNegativeInteger(Number.NaN), false);
  assert.equal(isSafeNonNegativeInteger('1'), false);
});

test('normalizeBoundedPositiveInteger applies fallback and upper bound', () => {
  assert.equal(normalizeBoundedPositiveInteger(5, 2, 10), 5);
  assert.equal(normalizeBoundedPositiveInteger(50, 2, 10), 10);
  assert.equal(normalizeBoundedPositiveInteger(0, 2, 10), 2);
  assert.equal(normalizeBoundedPositiveInteger(Number.POSITIVE_INFINITY, 2, 10), 2);
});

test('normalizeBoundedPositiveInteger normalizes malformed runtime options', () => {
  assert.equal(normalizeBoundedPositiveInteger(null, 2, 10), 2);
  assert.equal(normalizeBoundedPositiveInteger('5', 2, 10), 2);
  assert.equal(normalizeBoundedPositiveInteger(5, 'fallback', 10), 5);
  assert.equal(normalizeBoundedPositiveInteger(null, 'fallback', 10), 1);
  assert.equal(normalizeBoundedPositiveInteger(50, 2, 'max'), 2);
  assert.equal(normalizeBoundedPositiveInteger(50, 20, 10), 20);
});

test('normalizeBoundedNonNegativeInteger preserves zero stop-limits while bounding values', () => {
  assert.equal(normalizeBoundedNonNegativeInteger(0, 2, 10), 0);
  assert.equal(normalizeBoundedNonNegativeInteger(-1, 2, 10), 0);
  assert.equal(normalizeBoundedNonNegativeInteger(2.8, 1, 10), 2);
  assert.equal(normalizeBoundedNonNegativeInteger(50, 2, 10), 10);
});

test('normalizeBoundedNonNegativeInteger normalizes malformed runtime options', () => {
  assert.equal(normalizeBoundedNonNegativeInteger(null, 2, 10), 2);
  assert.equal(normalizeBoundedNonNegativeInteger('5', 2, 10), 2);
  assert.equal(normalizeBoundedNonNegativeInteger(Number.POSITIVE_INFINITY, 2, 10), 2);
  assert.equal(normalizeBoundedNonNegativeInteger(5, 'fallback', 10), 5);
  assert.equal(normalizeBoundedNonNegativeInteger(null, 'fallback', 10), 0);
  assert.equal(normalizeBoundedNonNegativeInteger(50, 2, 'max'), 2);
  assert.equal(normalizeBoundedNonNegativeInteger(50, 20, 10), 20);
});

test('safeNonNegativeInteger preserves only safe non-negative numbers', () => {
  assert.equal(safeNonNegativeInteger(42), 42);
  assert.equal(safeNonNegativeInteger(0), 0);
  assert.equal(safeNonNegativeInteger(-1), null);
  assert.equal(safeNonNegativeInteger(undefined), null);
});

test('saturatingSafeIntegerAdd clamps overflow and ignores unsafe increments', () => {
  assert.equal(saturatingSafeIntegerAdd(40, 2), 42);
  assert.equal(saturatingSafeIntegerAdd(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
  assert.equal(saturatingSafeIntegerAdd(10, -1), 10);
  assert.equal(saturatingSafeIntegerAdd(10, Number.NaN), 10);
});

test('saturatingSafeIntegerAdd normalizes malformed runtime base values', () => {
  assert.equal(saturatingSafeIntegerAdd(null, 2), 0);
  assert.equal(saturatingSafeIntegerAdd('10', 2), 0);
  assert.equal(saturatingSafeIntegerAdd(-1, 2), 0);
  assert.equal(saturatingSafeIntegerAdd(Number.NaN, 2), 0);
});

test('safe integer helpers use captured numeric intrinsics', () => {
  globalThis.Number = new Proxy(originalNumber, {
    get(target, property, receiver) {
      if (property === 'isSafeInteger' || property === 'isFinite' || property === 'MAX_SAFE_INTEGER') {
        throw new Error('Number static properties should not be read');
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
    apply(): never {
      throw new Error('Number constructor should not be called');
    },
    construct(): never {
      throw new Error('Number constructor should not be called');
    }
  });
  Math.floor = function floorShouldNotBeCalled(): never {
    throw new Error('Math.floor should not be called');
  };
  Math.max = function maxShouldNotBeCalled(): never {
    throw new Error('Math.max should not be called');
  };
  Math.min = function minShouldNotBeCalled(): never {
    throw new Error('Math.min should not be called');
  };

  try {
    assert.equal(isSafePositiveInteger(1), true);
    assert.equal(isSafeNonNegativeInteger(0), true);
    assert.equal(normalizeBoundedPositiveInteger(50, 2, 10), 10);
    assert.equal(normalizeBoundedNonNegativeInteger(2.8, 1, 10), 2);
    assert.equal(safeNonNegativeInteger(42), 42);
    assert.equal(saturatingSafeIntegerAdd(originalNumber.MAX_SAFE_INTEGER, 1), originalNumber.MAX_SAFE_INTEGER);
  } finally {
    globalThis.Number = originalNumber;
    Math.floor = originalMathFloor;
    Math.max = originalMathMax;
    Math.min = originalMathMin;
  }
});
