import { describe, expect, it } from 'vitest';
import { pickBlockedIsOverridable } from './util';

const w = (code: string, severity: 'block' | 'warn' = 'block', details: Record<string, unknown> = {}) =>
  ({ code, severity, message: '', details }) as never;

describe('pickBlockedIsOverridable', () => {
  it('lets the + menu try a Ruhezeit block, like a drop', () => {
    expect(pickBlockedIsOverridable({ warnings: [w('REST_PERIOD')] })).toBe(true);
  });
  it('keeps overlaps and admin-hard restrictions unselectable', () => {
    expect(pickBlockedIsOverridable({ warnings: [w('OVERLAP')] })).toBe(false);
    expect(
      pickBlockedIsOverridable({ warnings: [w('REST_PERIOD', 'block', { configuredHard: true })] }),
    ).toBe(false);
    expect(pickBlockedIsOverridable({ warnings: [w('REST_PERIOD'), w('OVERLAP')] })).toBe(false);
  });
});
