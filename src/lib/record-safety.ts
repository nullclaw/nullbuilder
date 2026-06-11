import { isSafePositiveInteger } from './number-safety';

const ARRAY_IS_ARRAY = Array.isArray.bind(Array) as typeof Array.isArray;
const MATH_MIN = Math.min.bind(Math) as typeof Math.min;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object) as typeof Object.getPrototypeOf;
const OBJECT_PROTOTYPE = Object.prototype;

export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || isRuntimeArray(value)) {
    return null;
  }

  const prototype = objectPrototype(value);
  if (prototype === undefined) {
    return null;
  }

  return prototype === OBJECT_PROTOTYPE || prototype === null ? (value as Record<string, unknown>) : null;
}

export function readArray<T = unknown>(value: unknown): T[] {
  return isRuntimeArray(value) ? (value as T[]) : [];
}

export function readBoundedArray<T = unknown>(value: unknown, maxItems: unknown): T[] {
  const values = readArray<T>(value);
  const limit = normalizeArrayLimit(maxItems);
  if (limit <= 0) {
    return [];
  }

  const bounded: T[] = [];
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
  return isSafePositiveInteger(value) ? value : 0;
}

function isRuntimeArray(value: unknown): value is unknown[] {
  try {
    return ARRAY_IS_ARRAY(value);
  } catch {
    return false;
  }
}

function boundedArrayLength(value: unknown[], limit: number): number {
  try {
    return MATH_MIN(value.length, limit);
  } catch {
    return 0;
  }
}

function objectPrototype(value: object): object | null | undefined {
  try {
    return OBJECT_GET_PROTOTYPE_OF(value) as object | null;
  } catch {
    return undefined;
  }
}
