import { readSafeTextInput, type SafeTextInputOptions } from './text-safety';

const ENCODED_TEXT_CONTROL_CHARACTER_PATTERN =
  /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])|%d8%9c|%e2%80%(?:8[ef]|a[a-e])|%e2%81%a[6-9]/i;

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
