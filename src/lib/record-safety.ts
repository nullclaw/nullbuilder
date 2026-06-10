export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readBoundedArray(value: unknown, maxItems: unknown): unknown[] {
  const values = readArray(value);
  const limit = normalizeArrayLimit(maxItems);
  if (limit <= 0) {
    return [];
  }

  const bounded: unknown[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    bounded.push(values[index]);
  }

  return bounded;
}

function normalizeArrayLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
