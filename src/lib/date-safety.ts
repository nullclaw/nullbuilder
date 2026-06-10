import { readSafeTextInput } from './text-safety';

const DEFAULT_MAX_UTC_TIMESTAMP_LENGTH = 64;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export type UtcTimestampParseOptions = {
  maxLength?: number;
};

export function safeUtcTimestampText(value: unknown, options: UtcTimestampParseOptions = {}): string {
  return typeof value === 'string' && parseUtcTimestampMillis(value, options) !== null ? value : '';
}

export function parseUtcTimestampMillis(
  value: string | null | undefined,
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

  const match = UTC_TIMESTAMP_PATTERN.exec(safeValue);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');

  const date = new Date(0);
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
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeMaxTimestampLength(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_UTC_TIMESTAMP_LENGTH;
}
