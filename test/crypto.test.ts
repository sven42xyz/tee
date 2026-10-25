import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  decryptJson,
  decryptStream,
  encryptedSize,
  encryptFile,
  encryptJson,
  generateKey,
  importKey,
  keyFromHash,
} from '../src/scripts/crypto';

/** Delivers the bytes in random-sized pieces, like a network stream. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (pos >= bytes.length) return ctrl.close();
      const n = 1 + Math.floor(Math.random() * 300_000);
      ctrl.enqueue(bytes.slice(pos, pos + n));
      pos += n;
    },
  });
}

function randomBytes(size: number) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(size, i + 65536)));
  return out;
}

describe('keys', () => {
  it('generates 256-bit keys and reads them from the link fragment', async () => {
    const key = generateKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyFromHash(`#k=${key}`)).toBe(key);
    await expect(importKey(key)).resolves.toBeDefined();
  });

  it('rejects malformed fragments and keys', async () => {
    expect(keyFromHash('#k=short')).toBeNull();
    expect(keyFromHash('')).toBeNull();
    await expect(importKey('abc')).rejects.toThrow();
  });
});

describe('texts and metadata', () => {
  it('round-trips JSON with unicode', async () => {
    const key = await importKey(generateKey());
    const value = { k: 'link', c: 'https://example.com/ä?ö=1 🎉' };
    const ct = await encryptJson(key, value);
    expect(ct).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decryptJson(key, ct)).toEqual(value);
  });

  it('fails with the wrong key', async () => {
    const ct = await encryptJson(await importKey(generateKey()), { a: 1 });
    await expect(decryptJson(await importKey(generateKey()), ct)).rejects.toThrow();
  });
});

describe('files', () => {
  const sizes = [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 2 * CHUNK_BYTES, Math.floor(2.5 * CHUNK_BYTES)];

  it.each(sizes)('round-trips %i bytes and predicts the ciphertext size', async (size) => {
    const key = await importKey(generateKey());
    const plain = randomBytes(size);
    const sealed = await encryptFile(key, new Blob([plain]));
    expect(sealed.size).toBe(encryptedSize(size));
    const out = new Uint8Array(await (await decryptStream(key, streamOf(new Uint8Array(await sealed.arrayBuffer())), 'x')).arrayBuffer());
    expect(out).toEqual(plain);
  });

  describe('tampering is detected', async () => {
    const key = await importKey(generateKey());
    const sealed = new Uint8Array(await (await encryptFile(key, new Blob([randomBytes(Math.floor(2.5 * CHUNK_BYTES))]))).arrayBuffer());
    const HEADER = 16;
    const CHUNK = CHUNK_BYTES + 16;
    const fails = (bytes: Uint8Array, k = key) => expect(decryptStream(k, streamOf(bytes), 'x')).rejects.toThrow();

    it('truncation by one byte', () => fails(sealed.slice(0, -1)));
    it('dropping the last chunk', () => fails(sealed.slice(0, HEADER + 2 * CHUNK)));
    it('swapped chunks', () => {
      const swapped = sealed.slice();
      swapped.set(sealed.slice(HEADER + CHUNK, HEADER + 2 * CHUNK), HEADER);
      swapped.set(sealed.slice(HEADER, HEADER + CHUNK), HEADER + CHUNK);
      return fails(swapped);
    });
    it('a flipped bit', () => {
      const flipped = sealed.slice();
      flipped[HEADER + 10] ^= 1;
      return fails(flipped);
    });
    it('the wrong key', async () => fails(sealed, await importKey(generateKey())));
  });
});
