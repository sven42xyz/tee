import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, generateCode, normalizeCode } from '../src/shared/codes';

describe('room codes', () => {
  it('uses no look-alike characters and no vowels', () => {
    expect(CODE_ALPHABET).not.toMatch(/[01AEIOUL]/);
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('uses every character of the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of generateCode()) seen.add(c);
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });

  it('normalizes input and still accepts legacy codes with vowels', () => {
    expect(normalizeCode(' bcd-fgh ')).toBe('BCDFGH');
    expect(normalizeCode('cuntds')).toBe('CUNTDS');
    expect(normalizeCode('ABCDO0')).toBeNull();
    expect(normalizeCode('ABC')).toBeNull();
  });
});
