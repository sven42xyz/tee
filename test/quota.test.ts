import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ipBucket } from '../src/server/quota';
import { GLOBAL_FILE_STORAGE_BYTES, IP_DAILY_UPLOAD_BYTES } from '../src/shared/limits';
import type { Item } from '../src/shared/types';
import { api, createRoom, postText, upload } from './helpers';

const quota = () => env.QUOTA.get(env.QUOTA.idFromName('global'));

/** Sets the stored-bytes counter directly, so tests need not upload 50 GB. */
const setFileBytes = (value: number) =>
  runInDurableObject(quota(), (_instance, state) => {
    state.storage.sql.exec(`INSERT OR REPLACE INTO counters (name, value) VALUES ('file_bytes', ?)`, value);
  });

describe('ipBucket', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::99', '2001:db8:abcd:12::/64'],
    ['2001:DB8:ABCD:0012:ffff::1', '2001:db8:abcd:12::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
  ])('%s → %s', (ip, bucket) => expect(ipBucket(ip)).toBe(bucket));
});

describe('global file storage limit', () => {
  it('rejects uploads beyond the limit and accepts them again after a deletion', async () => {
    const code = await createRoom();
    await setFileBytes(GLOBAL_FILE_STORAGE_BYTES - 1500);

    const first = await upload(code, new Uint8Array(1000));
    expect(first.status).toBe(201);
    const full = await upload(code, new Uint8Array(1000));
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({ error: 'storage_full' });

    const { id } = (await first.json()) as Item;
    await api(`/api/rooms/${code}/items/${id}`, { method: 'DELETE' });
    expect((await upload(code, new Uint8Array(1000))).status).toBe(201);
  });

  it('does not count texts against the file storage', async () => {
    const code = await createRoom();
    await setFileBytes(GLOBAL_FILE_STORAGE_BYTES);
    expect((await postText(code, { text: 'still fine' })).status).toBe(201);
  });

  it('recounts the real total from R2', async () => {
    await env.FILES.put('rooms/AAAAAA/a', new Uint8Array(700));
    await env.FILES.put('rooms/BBBBBB/b', new Uint8Array(300));
    await setFileBytes(123_456_789);
    await runInDurableObject(quota(), (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(quota());
    // Storage is shared within this file, so compare against everything that is really in R2
    const objects = (await env.FILES.list()).objects;
    const total = objects.reduce((sum, o) => sum + o.size, 0);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect((await quota().status()).fileBytes).toBe(total);
  });
});

describe('daily upload volume per network', () => {
  it('counts files and texts, and deleting does not refund it', async () => {
    const ip = '198.51.100.7';
    expect(await quota().reserve(ip, IP_DAILY_UPLOAD_BYTES - 100, 'file')).toEqual({ ok: true });
    await quota().releaseFile(IP_DAILY_UPLOAD_BYTES - 100);
    expect(await quota().reserve(ip, 200, 'text')).toEqual({ ok: false, error: 'quota_exceeded' });
    expect(await quota().reserve('198.51.100.8', 200, 'text')).toEqual({ ok: true });
  });

  it('treats a whole IPv6 /64 as one network', async () => {
    expect(await quota().reserve('2001:db8:1:2::1', IP_DAILY_UPLOAD_BYTES, 'text')).toEqual({ ok: true });
    expect(await quota().reserve('2001:db8:1:2:ffff::9', 1, 'text')).toEqual({ ok: false, error: 'quota_exceeded' });
    expect(await quota().reserve('2001:db8:1:3::1', 1, 'text')).toEqual({ ok: true });
  });

  it('is enforced through the API', async () => {
    const code = await createRoom();
    const ip = '198.51.100.20';
    await quota().reserve(ip, IP_DAILY_UPLOAD_BYTES - 10, 'text');
    const res = await upload(code, new Uint8Array(100), { ip });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'quota_exceeded' });
  });

  it('stores no IP addresses, only hashes', async () => {
    await quota().reserve('203.0.113.99', 1, 'text');
    const ids = await runInDurableObject(quota(), (_instance, state) =>
      state.storage.sql.exec<{ id: string }>('SELECT id FROM ip_usage').toArray().map((r) => r.id),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(id).not.toContain('203.0.113.99');
    }
  });
});
