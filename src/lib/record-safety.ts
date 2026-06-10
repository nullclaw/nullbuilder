export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || isRuntimeArray(value)) {
    return null;
  }

  const prototype = objectPrototype(value);
  if (prototype === undefined) {
    return null;
  }

  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

export function readArray(value: unknown): unknown[] {
  return isRuntimeArray(value) ? value : [];
}

export function readBoundedArray(value: unknown, maxItems: unknown): unknown[] {
  const values = readArray(value);
  const limit = normalizeArrayLimit(maxItems);
  if (limit <= 0) {
    return [];
  }

  const bounded: unknown[] = [];
  const count = boundedArrayLength(values, limit);
  for (let index = 0; index < count; index += 1) {
    try {
      bounded[index] = values[index];
    } catch {
      break;
    }
  }

  return bounded;
}

function normalizeArrayLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isRuntimeArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function boundedArrayLength(value: unknown[], limit: number): number {
  try {
    return Math.min(value.length, limit);
  } catch {
    return 0;
  }
}

function objectPrototype(value: object): object | null | undefined {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    return undefined;
  }
}
