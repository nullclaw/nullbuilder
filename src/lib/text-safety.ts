const ANSI_STRING_CONTROL_PATTERN = /(?:\x1b[\]PX^_]|\x90|\x98|\x9d|\x9e|\x9f)(?:[^\x07\x1b\x9c]|\x1b(?!\\))*?(?:\x07|\x1b\\|\x9c|$)/g;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BIDI_FORMAT_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_FORMAT_CONTROL_TEST_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_CHARACTER_TEST_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9]\d*$/;
const MAX_SAFE_INTEGER_DIGITS = Number.MAX_SAFE_INTEGER.toString().length;

export const TERMINAL_TRUNCATION_SUFFIX = '...';
export const MAX_TEXT_SAFETY_LENGTH = 8192;
export const MAX_TEXT_INPUT_LENGTH = 512;

export type SafeTextOptions = {
  maxLength: unknown;
  fallback?: string;
  suffix?: string;
  trim?: boolean;
};

export type SafeTextInputOptions = {
  maxLength?: unknown;
  trim?: boolean;
};

export function readSafeTextInput(value: unknown, options: SafeTextInputOptions = {}): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const maxLength = normalizeInputLength(options.maxLength);
  if (maxLength === null || value.length > maxLength) {
    return null;
  }

  if (CONTROL_CHARACTER_TEST_PATTERN.test(value) || BIDI_FORMAT_CONTROL_TEST_PATTERN.test(value) || hasLoneSurrogate(value)) {
    return null;
  }

  return options.trim ? value.trim() : value;
}

export function parsePositiveIntegerText(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (value.length > MAX_SAFE_INTEGER_DIGITS || !POSITIVE_INTEGER_TEXT_PATTERN.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function sanitizeText(value: string, options: SafeTextOptions): string {
  const sanitized = truncateText(
    replaceLoneSurrogates(
      value
        .replace(ANSI_STRING_CONTROL_PATTERN, '')
        .replace(ANSI_ESCAPE_PATTERN, '')
        .replace(CONTROL_CHARACTER_PATTERN, ' ')
        .replace(BIDI_FORMAT_CONTROL_PATTERN, ' ')
    ),
    options.maxLength,
    options.suffix ?? ''
  );
  const normalized = options.trim ? sanitized.trim() : sanitized;

  return normalized || options.fallback || normalized;
}

export function sanitizeTerminalLine(value: string, maxLength: unknown): string {
  return sanitizeText(value, {
    maxLength,
    suffix: TERMINAL_TRUNCATION_SUFFIX
  });
}

export function sanitizeTerminalCell(value: string, lineMaxLength: unknown, cellMaxLength: unknown): string {
  return truncateText(sanitizeTerminalLine(value, lineMaxLength), cellMaxLength, TERMINAL_TRUNCATION_SUFFIX);
}

function truncateText(value: string, maxLength: unknown, suffix: string): string {
  const normalizedMaxLength = normalizeTextLength(maxLength);

  if (normalizedMaxLength === 0) {
    return '';
  }

  const suffixLength = normalizedMaxLength > suffix.length ? suffix.length : 0;
  const prefixLimit = normalizedMaxLength - suffixLength;
  let prefix = '';
  let length = 0;

  for (const character of value) {
    if (length >= normalizedMaxLength) {
      return suffixLength > 0 ? `${prefix}${suffix}` : prefix;
    }

    if (length < prefixLimit) {
      prefix += character;
    }
    length += 1;
  }

  return value;
}

function normalizeInputLength(value: unknown): number | null {
  if (value === undefined) {
    return MAX_TEXT_INPUT_LENGTH;
  }

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTextLength(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return 0;
  }

  if (!Number.isFinite(value)) {
    return MAX_TEXT_SAFETY_LENGTH;
  }

  return Math.min(Math.floor(value), MAX_TEXT_SAFETY_LENGTH);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!isLowSurrogate(nextCodeUnit)) {
        return true;
      }
      index += 1;
    } else if (isLowSurrogate(codeUnit)) {
      return true;
    }
  }

  return false;
}

function replaceLoneSurrogates(value: string): string {
  if (!hasLoneSurrogate(value)) {
    return value;
  }

  let output = '';

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (isLowSurrogate(nextCodeUnit)) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += ' ';
      }
    } else if (isLowSurrogate(codeUnit)) {
      output += ' ';
    } else {
      output += value[index];
    }
  }

  return output;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
