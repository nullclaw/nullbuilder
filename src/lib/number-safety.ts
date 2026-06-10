export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeBoundedPositiveInteger(value: unknown, fallback: unknown, max: unknown): number {
  const safeFallback = isSafePositiveInteger(fallback) ? fallback : 1;
  const safeMax = isSafePositiveInteger(max) ? Math.max(max, safeFallback) : safeFallback;

  if (!isSafePositiveInteger(value)) {
    return safeFallback;
  }

  return Math.min(value, safeMax);
}

export function normalizeBoundedNonNegativeInteger(value: unknown, fallback: unknown, max: unknown): number {
  const safeFallback = isSafeNonNegativeInteger(fallback) ? fallback : 0;
  const safeMax = isSafeNonNegativeInteger(max) ? Math.max(max, safeFallback) : safeFallback;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return safeFallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.min(Math.floor(value), safeMax);
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
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
