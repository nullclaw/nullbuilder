export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeBoundedPositiveInteger(value: number, fallback: number, max: number): number {
  if (!isSafePositiveInteger(value)) {
    return fallback;
  }

  return Math.min(value, max);
}

export function safeNonNegativeInteger(value: unknown): number | null {
  return isSafeNonNegativeInteger(value) ? value : null;
}

export function saturatingSafeIntegerAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0) {
    return left;
  }

  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
