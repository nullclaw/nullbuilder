type SecurityHeaderEntry = readonly [name: string, value: string];

function securityHeader(name: string, value: string): SecurityHeaderEntry {
  return Object.freeze([name, value]);
}

const SECURITY_HEADERS: ReadonlyArray<SecurityHeaderEntry> = Object.freeze([
  securityHeader('Content-Security-Policy', "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"),
  securityHeader('Cross-Origin-Opener-Policy', 'same-origin'),
  securityHeader('Cross-Origin-Resource-Policy', 'same-origin'),
  securityHeader('Origin-Agent-Cluster', '?1'),
  securityHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()'),
  securityHeader('Referrer-Policy', 'no-referrer'),
  securityHeader('X-Content-Type-Options', 'nosniff'),
  securityHeader('X-Frame-Options', 'DENY')
]);

export function securityHeaderEntries(): ReadonlyArray<SecurityHeaderEntry> {
  return SECURITY_HEADERS;
}

export function applySecurityHeaders(headers: Headers): void {
  for (let index = 0; index < SECURITY_HEADERS.length; index += 1) {
    const header = SECURITY_HEADERS[index];
    headers.set(header[0], header[1]);
  }
}
