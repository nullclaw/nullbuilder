const SECURITY_HEADERS = [
  ['Content-Security-Policy', "base-uri 'none'; frame-ancestors 'none'; object-src 'none'"],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY']
] as const;

export function securityHeaderEntries(): ReadonlyArray<readonly [string, string]> {
  return SECURITY_HEADERS;
}

export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of SECURITY_HEADERS) {
    headers.set(name, value);
  }
}
