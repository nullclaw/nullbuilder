const SECURITY_HEADERS = [
  ['Content-Security-Policy', "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Origin-Agent-Cluster', '?1'],
  ['Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY']
] as const;

export function securityHeaderEntries(): ReadonlyArray<readonly [string, string]> {
  return SECURITY_HEADERS;
}

export function applySecurityHeaders(headers: Headers): void {
  for (let index = 0; index < SECURITY_HEADERS.length; index += 1) {
    const header = SECURITY_HEADERS[index];
    headers.set(header[0], header[1]);
  }
}
