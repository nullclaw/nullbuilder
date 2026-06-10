import type { Handle } from '@sveltejs/kit';
import { applySecurityHeaders } from '$lib/server/security-headers';

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  applySecurityHeaders(response.headers);
  return response;
};
