import { readSafeTextInput, type SafeTextInputOptions } from './text-safety';

const ENCODED_TEXT_CONTROL_CHARACTER_PATTERN =
  /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])|%d8%9c|%e2%80%(?:8[ef]|a[a-e])|%e2%81%a[6-9]/i;
const UNSAFE_HTTP_URL_CHARACTER_PATTERN = /[\u0000-\u0020\u007f-\u009f"'<>`\\{}|]/;

export function readSafeUrlText(value: unknown, options: SafeTextInputOptions): string | null {
  const safe = readSafeTextInput(value, options);
  if (safe === null || hasEncodedTextControlCharacter(safe)) {
    return null;
  }

  return safe;
}

export function hasEncodedTextControlCharacter(value: string): boolean {
  return ENCODED_TEXT_CONTROL_CHARACTER_PATTERN.test(value);
}

export function safeHttpUrlText(value: unknown, options: SafeTextInputOptions): string | null {
  const safeValue = readSafeUrlText(value, options);
  if (!safeValue || UNSAFE_HTTP_URL_CHARACTER_PATTERN.test(safeValue)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(safeValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  if (url.username !== '' || url.password !== '') {
    return null;
  }

  return safeValue;
}
