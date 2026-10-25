/**
 * Security headers for every response the Worker sends.
 *
 * The CSP only allows tee's own scripts, styles and connections, plus Cloudflare
 * Turnstile (https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
 * There are no inline scripts or styles: Astro ships CSS as files (`inlineStylesheets: 'never'`).
 * `'self'` in connect-src also covers the same-origin WebSocket (wss:) in current browsers.
 */
const TURNSTILE = 'https://challenges.cloudflare.com';

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE}`,
  "style-src 'self'",
  // blob: for decrypted downloads, data: for small inline images some browsers use internally
  "img-src 'self' data: blob:",
  `connect-src 'self' ${TURNSTILE}`,
  `frame-src ${TURNSTILE}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  // Room URLs carry the room code (the key of unencrypted rooms): never send them to other sites
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

export function withSecurityHeaders(response: Response, dev = false): Response {
  // WebSocket upgrades must be passed through untouched
  if (response.status === 101 || response.webSocket) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(HEADERS)) {
    // In `astro dev`, Vite injects styles at runtime, which the CSP would block
    if (dev && name === 'Content-Security-Policy') continue;
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }
  return secured;
}
