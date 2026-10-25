import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { moderationStub, signAdmin, verifyAdmin } from '../src/server/moderation';
import { ROOM_TTL_MS } from '../src/shared/limits';
import { api, BASE, createRoom, postText, report } from './helpers';

const room = (code: string) => env.ROOM.get(env.ROOM.idFromName(code));
const valid = { description: 'A film shared without permission.', goodFaith: true };

async function moderate(code: string, action: string, sigFor = code, exp = Date.now() + 60_000) {
  const sig = await signAdmin(env, sigFor, exp);
  return api(`/api/admin/rooms/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, exp, sig }),
  });
}

describe('reports', () => {
  it('validates the report', async () => {
    const code = await createRoom();
    expect((await report(code, { ...valid, category: 'nonsense' })).status).toBe(400);
    expect((await report(code, { ...valid, category: 'copyright', goodFaith: false })).status).toBe(400);
    expect((await report(code, { ...valid, category: 'copyright', description: 'x' })).status).toBe(400);
    expect((await report('BCDFGH', { ...valid, category: 'copyright' })).status).toBe(404);
  });

  it('stores reports and leaves the room reachable for ordinary categories', async () => {
    const code = await createRoom();
    const res = await report(code, { ...valid, category: 'copyright', contact: 'reporter@example.com' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ blocked: false });
    expect((await api(`/api/rooms/${code}`)).status).toBe(200);

    const stored = await moderationStub(env).reportsFor(code);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ category: 'copyright', contact: 'reporter@example.com', autoBlocked: false });
  });

  it.each(['csam', 'sexual_violence'])('a %s report blocks the room immediately', async (category) => {
    const code = await createRoom();
    const res = await report(code, { ...valid, category });
    expect(await res.json()).toMatchObject({ blocked: true });

    expect((await api(`/api/rooms/${code}`)).status).toBe(451);
    expect((await postText(code, { text: 'more' })).status).toBe(451);
    const ws = await SELF.fetch(`${BASE}/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
    expect(ws.status).toBe(451);
  });
});

describe('signed moderation links', () => {
  it('accept only the right room, an unexpired link and an untampered signature', async () => {
    const exp = Date.now() + 60_000;
    const sig = await signAdmin(env, 'BCDFGH', exp);
    expect(await verifyAdmin(env, 'BCDFGH', exp, sig)).toBe(true);
    expect(await verifyAdmin(env, 'CDFGHJ', exp, sig)).toBe(false);
    expect(await verifyAdmin(env, 'BCDFGH', exp + 1, sig)).toBe(false);
    expect(await verifyAdmin(env, 'BCDFGH', exp, `AAAA${sig.slice(4)}`)).toBe(false);

    const past = Date.now() - 1000;
    expect(await verifyAdmin(env, 'BCDFGH', past, await signAdmin(env, 'BCDFGH', past))).toBe(false);
  });

  it('reject actions with a link for another room', async () => {
    const code = await createRoom();
    expect((await moderate(code, 'block', 'BCDFGH')).status).toBe(403);
    expect((await api(`/api/rooms/${code}`)).status).toBe(200);
  });
});

describe('moderation actions', () => {
  it('block and unblock', async () => {
    const code = await createRoom();
    expect((await moderate(code, 'block')).status).toBe(200);
    expect((await api(`/api/rooms/${code}`)).status).toBe(451);
    expect((await moderate(code, 'unblock')).status).toBe(200);
    expect((await api(`/api/rooms/${code}`)).status).toBe(200);
  });

  it('freeze keeps the room past its normal expiry', async () => {
    const code = await createRoom();
    expect((await moderate(code, 'freeze')).status).toBe(200);
    expect((await room(code).stats())?.frozenUntil).toBeGreaterThan(Date.now());

    await runInDurableObject(room(code), (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'last_activity'`, String(Date.now() - ROOM_TTL_MS * 3));
    });
    await runDurableObjectAlarm(room(code));
    expect(await room(code).info()).toMatchObject({ blocked: true });
  });

  it('delete removes the room and its files', async () => {
    const code = await createRoom();
    await api(`/api/rooms/${code}/files`, { method: 'POST', headers: { 'x-filename': 'a.bin' }, body: new Uint8Array(500) });
    expect((await moderate(code, 'delete')).status).toBe(200);
    expect(await room(code).info()).toBeNull();
    expect((await env.FILES.list({ prefix: `rooms/${code}/` })).objects).toHaveLength(0);
  });

  it('rejects unknown actions', async () => {
    const code = await createRoom();
    expect((await moderate(code, 'nuke')).status).toBe(400);
  });
});
