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
