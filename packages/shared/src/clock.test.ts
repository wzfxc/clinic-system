import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';

describe('FixedClock', () => {
  it('returns the configured instant and advances on demand', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });

  it('returns a copy so callers cannot mutate the clock', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
