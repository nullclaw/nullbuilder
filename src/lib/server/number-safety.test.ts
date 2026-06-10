import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  normalizeBoundedPositiveInteger,
  safeNonNegativeInteger,
  saturatingSafeIntegerAdd
} from './number-safety';

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
