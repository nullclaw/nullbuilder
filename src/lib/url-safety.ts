import { readSafeTextInput, type SafeTextInputOptions } from './text-safety';

const ENCODED_TEXT_CONTROL_CHARACTER_PATTERN =
  /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])|%d8%9c|%e2%80%(?:8[ef]|a[a-e])|%e2%81%a[6-9]/i;
const UNSAFE_HTTP_URL_CHARACTER_PATTERN = /[\u0000-\u0020\u007f-\u009f"'<>`\\{}|]/;
const MAX_HTTP_PORT = 65_535;
const URL_CONSTRUCTOR = globalThis.URL;

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

  if (hasUnsafeHttpUrlPathSyntax(safeValue)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL_CONSTRUCTOR(safeValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  if (url.protocol === 'http:' && !isCanonicalLoopbackHttpUrl(safeValue)) {
    return null;
  }

  if (url.username !== '' || url.password !== '') {
    return null;
  }

  return safeValue;
}

export function hasUnsafeHttpUrlPathSyntax(value: string): boolean {
  const path = rawHttpUrlPath(value);
  if (!path) {
    return false;
  }

  let segmentStart = 1;
  for (let index = 1; index <= path.length; index += 1) {
    if (index < path.length && path[index] !== '/') {
      continue;
    }

    const segment = path.slice(segmentStart, index);
    const isTrailingEmptySegment = index === path.length && segment.length === 0;
    if (segment.length === 0 && !isTrailingEmptySegment) {
      return true;
    }

    if (isDotUrlPathSegment(segment)) {
      return true;
    }

    segmentStart = index + 1;
  }

  return false;
}

export function isCanonicalLoopbackHttpUrl(value: string): boolean {
  const separator = value.indexOf('://');
  if (separator <= 0 || value.slice(0, separator).toLowerCase() !== 'http') {
    return false;
  }

  const rest = value.slice(separator + '://'.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  return isLoopbackAuthority(authority);
}

function rawHttpUrlPath(value: string): string {
  const authorityStart = value.indexOf('://');
  if (authorityStart === -1) {
    return '';
  }

  const pathStart = value.indexOf('/', authorityStart + '://'.length);
  if (pathStart === -1) {
    return '';
  }

  let pathEnd = value.length;
  const queryStart = value.indexOf('?', pathStart);
  if (queryStart !== -1) {
    pathEnd = Math.min(pathEnd, queryStart);
  }

  const hashStart = value.indexOf('#', pathStart);
  if (hashStart !== -1) {
    pathEnd = Math.min(pathEnd, hashStart);
  }

  return value.slice(pathStart, pathEnd);
}

function isDotUrlPathSegment(segment: string): boolean {
  let dots = 0;

  for (let index = 0; index < segment.length; ) {
    if (segment[index] === '.') {
      dots += 1;
      index += 1;
      continue;
    }

    if (isEncodedDot(segment, index)) {
      dots += 1;
      index += 3;
      continue;
    }

    return false;
  }

  return dots === 1 || dots === 2;
}

function isEncodedDot(value: string, index: number): boolean {
  return (
    value[index] === '%' &&
    value[index + 1] === '2' &&
    value[index + 2] !== undefined &&
    value[index + 2].toLowerCase() === 'e'
  );
}

function isLoopbackAuthority(authority: string): boolean {
  if (!authority || authority.includes('@')) {
    return false;
  }

  const hostPort = splitHostPort(authority);
  return hostPort !== null && isLoopbackHost(hostPort.host) && isSafeOptionalPort(hostPort.port);
}

function splitHostPort(authority: string): { host: string; port: string | null } | null {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) {
      return null;
    }

    const host = authority.slice(0, close + 1);
    const tail = authority.slice(close + 1);
    return tail === '' || tail.startsWith(':') ? { host, port: tail ? tail.slice(1) : null } : null;
  }

  const separator = authority.lastIndexOf(':');
  const host = separator === -1 ? authority : authority.slice(0, separator);
  if (host.includes(':')) {
    return null;
  }

  return {
    host,
    port: separator === -1 ? null : authority.slice(separator + 1)
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '[::1]' || isLoopbackIpv4(normalized);
}

function isSafeOptionalPort(port: string | null): boolean {
  if (port === null) {
    return true;
  }

  return parseCanonicalHttpPort(port) !== null;
}

function parseCanonicalHttpPort(port: string): number | null {
  if (port.length === 0 || port.length > 5) {
    return null;
  }

  let value = 0;
  for (let index = 0; index < port.length; index += 1) {
    const digit = port.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9 || (index === 0 && digit === 0)) {
      return null;
    }

    value = value * 10 + digit;
    if (value > MAX_HTTP_PORT) {
      return null;
    }
  }

  return value;
}

function isLoopbackIpv4(hostname: string): boolean {
  let octetStart = 0;
  let octetIndex = 0;

  for (let index = 0; index <= hostname.length; index += 1) {
    if (index !== hostname.length && hostname[index] !== '.') {
      continue;
    }

    if (octetIndex >= 4) {
      return false;
    }

    const octet = parseCanonicalIpv4Octet(hostname, octetStart, index);
    if (octet === null || (octetIndex === 0 && octet !== 127)) {
      return false;
    }

    octetIndex += 1;
    octetStart = index + 1;
  }

  return octetIndex === 4;
}

function parseCanonicalIpv4Octet(hostname: string, start: number, end: number): number | null {
  if (end <= start || end - start > 3 || (end - start > 1 && hostname[start] === '0')) {
    return null;
  }

  let value = 0;
  for (let index = start; index < end; index += 1) {
    const digit = hostname.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) {
      return null;
    }
    value = value * 10 + digit;
  }

  return value <= 255 ? value : null;
}
