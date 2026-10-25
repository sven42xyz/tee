import { describe, expect, it } from 'vitest';
import { withSecurityHeaders } from '../src/server/security';
import { api } from './helpers';

const EXPECTED = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'x-frame-options',
];

describe('security headers', () => {
  it('are set on API responses', async () => {
    const res = await api('/api/rooms/BCDFGH');
    for (const name of EXPECTED) expect(res.headers.has(name), name).toBe(true);
  });

  it('forbid inline scripts and styles and only allow Turnstile as a third party', () => {
    const csp = withSecurityHeaders(new Response('x')).headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('skip the CSP in development but keep the rest', () => {
    const res = withSecurityHeaders(new Response('x'), true);
    expect(res.headers.has('content-security-policy')).toBe(false);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('do not overwrite headers a response already sets', () => {
    const res = withSecurityHeaders(new Response('x', { headers: { 'Referrer-Policy': 'origin' } }));
    expect(res.headers.get('referrer-policy')).toBe('origin');
  });

  it('keep the room code out of referrers', async () => {
    expect((await api('/api/rooms/BCDFGH')).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
