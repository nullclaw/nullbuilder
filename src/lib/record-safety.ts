export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readBoundedArray(value: unknown, maxItems: unknown): unknown[] {
  const values = readArray(value);
  const limit = normalizeArrayLimit(maxItems);
  return limit > 0 ? values.slice(0, limit) : [];
}

function normalizeArrayLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
