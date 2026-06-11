const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger.bind(Number) as typeof Number.isSafeInteger;
const NUMBER_IS_FINITE = Number.isFinite.bind(Number) as typeof Number.isFinite;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MATH_FLOOR = Math.floor.bind(Math) as typeof Math.floor;
const MATH_MAX = Math.max.bind(Math) as typeof Math.max;
const MATH_MIN = Math.min.bind(Math) as typeof Math.min;

export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && NUMBER_IS_SAFE_INTEGER(value) && value > 0;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && NUMBER_IS_SAFE_INTEGER(value) && value >= 0;
}

export function normalizeBoundedPositiveInteger(value: unknown, fallback: unknown, max: unknown): number {
  const safeFallback = isSafePositiveInteger(fallback) ? fallback : 1;
  const safeMax = isSafePositiveInteger(max) ? MATH_MAX(max, safeFallback) : safeFallback;

  if (!isSafePositiveInteger(value)) {
    return safeFallback;
  }

  return MATH_MIN(value, safeMax);
}

export function normalizeBoundedNonNegativeInteger(value: unknown, fallback: unknown, max: unknown): number {
  const safeFallback = isSafeNonNegativeInteger(fallback) ? fallback : 0;
  const safeMax = isSafeNonNegativeInteger(max) ? MATH_MAX(max, safeFallback) : safeFallback;

  if (typeof value !== 'number' || !NUMBER_IS_FINITE(value)) {
    return safeFallback;
  }

  if (value <= 0) {
    return 0;
  }

  return MATH_MIN(MATH_FLOOR(value), safeMax);
}

export function safeNonNegativeInteger(value: unknown): number | null {
  return isSafeNonNegativeInteger(value) ? value : null;
}

export function saturatingSafeIntegerAdd(left: unknown, right: unknown): number {
  if (!isSafeNonNegativeInteger(left)) {
    return 0;
  }

  if (!isSafeNonNegativeInteger(right)) {
    return left;
  }

  const sum = left + right;
  return NUMBER_IS_SAFE_INTEGER(sum) ? sum : MAX_SAFE_INTEGER;
}
