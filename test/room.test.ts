import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, ROOM_MAX_LIFETIME_MS, ROOM_TTL_MS } from '../src/shared/limits';
import type { Item, ServerMessage } from '../src/shared/types';
import { api, BASE, createRoom, postText, upload } from './helpers';

const room = (code: string) => env.ROOM.get(env.ROOM.idFromName(code));

/** Moves a room's timestamps into the past, as if time had passed. */
function age(code: string, { created = 0, lastActivity = 0 }) {
  return runInDurableObject(room(code), (_instance, state) => {
    const sql = state.storage.sql;
    if (created) sql.exec(`UPDATE meta SET value = ? WHERE key = 'created_at'`, String(Date.now() - created));
    if (lastActivity) sql.exec(`UPDATE meta SET value = ? WHERE key = 'last_activity'`, String(Date.now() - lastActivity));
  });
}

describe('rooms', () => {
  it('creates a room and reports unknown ones as 404', async () => {
    const code = await createRoom();
    expect((await api(`/api/rooms/${code}`)).status).toBe(200);
    expect((await api('/api/rooms/BCDFGH')).status).toBe(404);
    expect((await api('/api/rooms/abc')).status).toBe(404);
  });

  it('stores texts and detects links', async () => {
    const code = await createRoom();
    const text = (await (await postText(code, { text: 'hello' })).json()) as Item;
    const link = (await (await postText(code, { text: 'https://example.com/x' })).json()) as Item;
    expect(text.kind).toBe('text');
    expect(link.kind).toBe('link');
    expect((await postText(code, { text: '   ' })).status).toBe(400);
  });

  it('uploads and downloads files byte for byte', async () => {
    const code = await createRoom();
    const data = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
    const res = await upload(code, data, { name: encodeURIComponent('Bericht äöü.pdf') });
    expect(res.status).toBe(201);
    const item = (await res.json()) as Item;
    expect(item.name).toBe('Bericht äöü.pdf');

    const dl = await api(`/api/rooms/${code}/files/${item.id}`);
    expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''Bericht%20%C3%A4%C3%B6%C3%BC.pdf");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(data);

    expect((await api(`/api/rooms/${code}/items/${item.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/rooms/${code}/files/${item.id}`)).status).toBe(404);
  });

  it(`accepts at most ${MAX_ITEMS} items`, async () => {
    const code = await createRoom();
    for (let i = 0; i < MAX_ITEMS; i++) expect((await postText(code, { text: `item ${i}` })).status).toBe(201);
    const full = await postText(code, { text: 'one too many' });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: 'room_full' });
  });
});

describe('encryption mode', () => {
  it('encrypted rooms only accept ciphertext', async () => {
    const code = await createRoom(true);
    expect((await postText(code, { text: 'plain' })).status).toBe(409);
    expect((await upload(code, new Uint8Array(10))).status).toBe(409);

    const item = (await (await postText(code, { ciphertext: 'AbC_-123' })).json()) as Item;
    expect(item).toMatchObject({ kind: 'text', enc: true, content: 'AbC_-123' });

    const file = (await (await upload(code, new Uint8Array(32), { name: 'bWV0YQ', encrypted: true })).json()) as Item;
    expect(file).toMatchObject({ kind: 'file', enc: true, name: 'bWV0YQ', mime: 'application/octet-stream' });
    const dl = await api(`/api/rooms/${code}/files/${file.id}`);
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="tee-encrypted.bin"');
  });

  it('unencrypted rooms reject ciphertext', async () => {
    const code = await createRoom(false);
    expect((await postText(code, { ciphertext: 'AbC' })).status).toBe(409);
    expect((await upload(code, new Uint8Array(10), { name: 'bWV0YQ', encrypted: true })).status).toBe(409);
  });
});

describe('live sync over WebSocket', () => {
  it('sends init and then new items', async () => {
    const code = await createRoom();
    await postText(code, { text: 'before' });

    const res = await SELF.fetch(`${BASE}/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: ServerMessage[] = [];
    ws.addEventListener('message', (e) => messages.push(JSON.parse(e.data as string)));
    ws.accept();

    await postText(code, { text: 'after' });
    await expect.poll(() => messages.length).toBeGreaterThanOrEqual(2);

    const init = messages[0];
    expect(init.type).toBe('init');
    if (init.type === 'init') {
      expect(init.items).toHaveLength(1);
      expect(init.devices).toBe(1);
      expect(init.maxExpiresAt - init.expiresAt).toBeGreaterThan(0);
    }
    expect(messages.some((m) => m.type === 'item' && m.item.content === 'after')).toBe(true);
    ws.close();
  });
});

describe('expiry', () => {
  it('deletes a room and its files 24 h after the last activity', async () => {
    const code = await createRoom();
    await upload(code, new Uint8Array(1000));
    await age(code, { lastActivity: ROOM_TTL_MS + 1000 });

    expect(await runDurableObjectAlarm(room(code))).toBe(true);
    expect(await room(code).info()).toBeNull();
    expect((await env.FILES.list({ prefix: `rooms/${code}/` })).objects).toHaveLength(0);
  });

  it('keeps an active room', async () => {
    const code = await createRoom();
    await age(code, { lastActivity: 60_000 });
    await runDurableObjectAlarm(room(code));
    expect(await room(code).info()).not.toBeNull();
  });

  it('deletes a room after the maximum lifetime even if it is active', async () => {
    const code = await createRoom();
    await age(code, { created: ROOM_MAX_LIFETIME_MS + 1000 });
    await runDurableObjectAlarm(room(code));
    expect(await room(code).info()).toBeNull();
  });
});
