import { SELF } from 'cloudflare:test';

export const BASE = 'https://tee.test';

let ipCounter = 0;
/** A fresh client IP per call, so the per-IP rate limits never interfere between tests. */
export const freshIp = () => `10.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}.1`;

export function api(path: string, init: RequestInit & { ip?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', init.ip ?? freshIp());
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

export async function createRoom(encrypted = false): Promise<string> {
  const res = await api('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted }),
  });
  if (res.status !== 201) throw new Error(`createRoom: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { code: string }).code;
}

export function postText(code: string, body: object, ip?: string) {
  return api(`/api/rooms/${code}/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ip,
  });
}

export function upload(code: string, data: Uint8Array<ArrayBuffer>, opts: { name?: string; encrypted?: boolean; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-filename': opts.name ?? encodeURIComponent('test.bin') };
  if (opts.encrypted) headers['x-encrypted'] = '1';
  return api(`/api/rooms/${code}/files`, { method: 'POST', headers, body: data, ip: opts.ip });
}

export function report(code: string, body: object) {
  return api(`/api/rooms/${code}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
