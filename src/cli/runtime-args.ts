export const MAX_CLI_ARGS = 128;

const ARRAY_IS_ARRAY = Array.isArray.bind(Array) as typeof Array.isArray;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger.bind(Number) as typeof Number.isSafeInteger;

export type CliArgVectorOptions = {
  start?: number;
  maxArgs?: number;
};

export function readCliArgVector(value: unknown, options: CliArgVectorOptions = {}): string[] {
  const values = readRuntimeArray(value);
  if (values === null) {
    throw new Error('Invalid CLI argument.');
  }

  const length = readRuntimeArrayLength(values);
  if (length === null) {
    throw new Error('Invalid CLI argument.');
  }

  const start = normalizeStart(options.start ?? 0);
  const maxArgs = normalizeMaxArgs(options.maxArgs ?? MAX_CLI_ARGS);
  const count = length > start ? length - start : 0;
  if (count > maxArgs) {
    throw new Error('Too many CLI arguments.');
  }

  const args: string[] = [];
  for (let index = start; index < length; index += 1) {
    const entry = readRuntimeArrayItem(values, index);
    if (!entry.ok || typeof entry.value !== 'string') {
      throw new Error('Invalid CLI argument.');
    }

    args[args.length] = entry.value;
  }

  return args;
}

function normalizeStart(value: number): number {
  return NUMBER_IS_SAFE_INTEGER(value) && value >= 0 ? value : 0;
}

function normalizeMaxArgs(value: number): number {
  return NUMBER_IS_SAFE_INTEGER(value) && value >= 0 && value <= MAX_CLI_ARGS ? value : MAX_CLI_ARGS;
}

function readRuntimeArray(value: unknown): readonly unknown[] | null {
  try {
    return ARRAY_IS_ARRAY(value) ? value : null;
  } catch {
    return null;
  }
}

function readRuntimeArrayLength(value: readonly unknown[]): number | null {
  try {
    const length = value.length;
    return NUMBER_IS_SAFE_INTEGER(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

function readRuntimeArrayItem(
  values: readonly unknown[],
  index: number
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: values[index] };
  } catch {
    return { ok: false };
  }
}
