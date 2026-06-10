const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\|$)|[@-Z\\-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export const TERMINAL_TRUNCATION_SUFFIX = '...';

export type SafeTextOptions = {
  maxLength: number;
  fallback?: string;
  suffix?: string;
  trim?: boolean;
};

export function sanitizeText(value: string, options: SafeTextOptions): string {
  const sanitized = truncateText(
    value.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHARACTER_PATTERN, ' '),
    options.maxLength,
    options.suffix ?? ''
  );
  const normalized = options.trim ? sanitized.trim() : sanitized;

  return normalized || options.fallback || normalized;
}

export function sanitizeTerminalLine(value: string, maxLength: number): string {
  return sanitizeText(value, {
    maxLength,
    suffix: TERMINAL_TRUNCATION_SUFFIX
  });
}

export function sanitizeTerminalCell(value: string, lineMaxLength: number, cellMaxLength: number): string {
  return truncateText(sanitizeTerminalLine(value, lineMaxLength), cellMaxLength, TERMINAL_TRUNCATION_SUFFIX);
}

function truncateText(value: string, maxLength: number, suffix: string): string {
  const suffixLength = maxLength > suffix.length ? suffix.length : 0;
  const prefixLimit = maxLength - suffixLength;
  let prefix = '';
  let length = 0;

  for (const character of value) {
    if (length >= maxLength) {
      return suffixLength > 0 ? `${prefix}${suffix}` : prefix;
    }

    if (length < prefixLimit) {
      prefix += character;
    }
    length += 1;
  }

  return value;
}
