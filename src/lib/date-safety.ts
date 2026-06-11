import { normalizeBoundedPositiveInteger } from './number-safety';
import { readSafeTextInput } from './text-safety';

const DEFAULT_MAX_UTC_TIMESTAMP_LENGTH = 64;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_CONSTRUCTOR = Date;
const NUMBER_IS_FINITE = Number.isFinite.bind(Number) as typeof Number.isFinite;

export type UtcTimestampParseOptions = {
  maxLength?: unknown;
};

export function safeUtcTimestampText(value: unknown, options: UtcTimestampParseOptions = {}): string {
  return typeof value === 'string' && parseUtcTimestampMillis(value, options) !== null ? value : '';
}

export function parseUtcTimestampMillis(
  value: unknown,
  options: UtcTimestampParseOptions = {}
): number | null {
  if (!value) {
    return null;
  }

  const safeValue = readSafeTextInput(value, {
    maxLength: normalizeMaxTimestampLength(options.maxLength),
    trim: false
  });
  if (!safeValue) {
    return null;
  }

  if (!UTC_TIMESTAMP_PATTERN.test(safeValue)) {
    return null;
  }

  const timestampParts = parseUtcTimestampParts(safeValue);
  if (timestampParts === null) {
    return null;
  }

  const { year, month, day, hour, minute, second, millisecond } = timestampParts;

  const date = new DATE_CONSTRUCTOR(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  const timestamp = date.getTime();
  return NUMBER_IS_FINITE(timestamp) ? timestamp : null;
}

function normalizeMaxTimestampLength(value: unknown): number {
  return normalizeBoundedPositiveInteger(
    value,
    DEFAULT_MAX_UTC_TIMESTAMP_LENGTH,
    DEFAULT_MAX_UTC_TIMESTAMP_LENGTH
  );
}

function parseUtcTimestampParts(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} | null {
  const year = parseFixedWidthDecimal(value, 0, 4);
  const month = parseFixedWidthDecimal(value, 5, 7);
  const day = parseFixedWidthDecimal(value, 8, 10);
  const hour = parseFixedWidthDecimal(value, 11, 13);
  const minute = parseFixedWidthDecimal(value, 14, 16);
  const second = parseFixedWidthDecimal(value, 17, 19);
  const millisecond = parseUtcMillisecond(value);

  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    second === null ||
    millisecond === null
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond
  };
}

function parseUtcMillisecond(value: string): number | null {
  if (value[19] === 'Z') {
    return 0;
  }

  if (value[19] !== '.') {
    return null;
  }

  const end = value.length - 1;
  const digits = end - 20;
  if (digits < 1 || digits > 3 || value[end] !== 'Z') {
    return null;
  }

  const parsed = parseFixedWidthDecimal(value, 20, end);
  if (parsed === null) {
    return null;
  }

  if (digits === 1) {
    return parsed * 100;
  }

  if (digits === 2) {
    return parsed * 10;
  }

  return parsed;
}

function parseFixedWidthDecimal(value: string, start: number, end: number): number | null {
  if (end <= start || end > value.length) {
    return null;
  }

  let parsed = 0;
  for (let index = start; index < end; index += 1) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) {
      return null;
    }

    parsed = parsed * 10 + digit;
  }

  return parsed;
}
