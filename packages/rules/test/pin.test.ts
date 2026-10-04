import { describe, expect, it } from 'vitest';
import { isWeakPin } from '../src';

describe('isWeakPin', () => {
  it('rejects all-equal and straight sequences', () => {
    for (const p of ['000000', '111111', '123456', '654321', '012345', '987654'])
      expect(isWeakPin(p), p).toBe(true);
  });
  it('accepts mixed PINs', () => {
    for (const p of ['135792', '482915', '121212']) expect(isWeakPin(p), p).toBe(false);
  });
});

import { resolveRequired } from '../src';
describe('resolveRequired', () => {
  it('override beats weekday default beats 0', () => {
    expect(resolveRequired('2026-10-12', { 1: 3 }, {})).toBe(3);
    expect(resolveRequired('2026-10-12', { 1: 3 }, { '2026-10-12': 0 })).toBe(0);
    expect(resolveRequired('2026-10-13', { 1: 3 }, {})).toBe(0);
    expect(resolveRequired('2026-10-17', new Map([[6, 1]]), new Map())).toBe(1);
  });
});
