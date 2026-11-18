import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney } from './format';

describe('format', () => {
  it('formats a UTC instant in the clinic time zone', () => {
    expect(formatDateTime('2026-01-15T22:30:00Z', 'Europe/Kyiv', 'en')).toContain('12:30');
  });
  it('formats money with the clinic currency', () => {
    expect(formatMoney(1500, 'UAH', 'en')).toMatch(/1,500/);
  });
});
