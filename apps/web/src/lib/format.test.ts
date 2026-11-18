import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney, formatMoneyMinor } from './format';

describe('format', () => {
  it('formats a UTC instant in the clinic time zone', () => {
    expect(formatDateTime('2026-01-15T22:30:00Z', 'Europe/Kyiv', 'en')).toContain('12:30');
  });
  it('formats money with the clinic currency', () => {
    expect(formatMoney(1500, 'UAH', 'en')).toMatch(/1,500/);
  });
  it('formats minor currency units in uk, en and pl', () => {
    expect(formatMoneyMinor(123450, 'UAH', 'uk')).toMatch(/1[\s\u00a0]234,50/);
    expect(formatMoneyMinor(123450, 'PLN', 'pl')).toMatch(/1[\s\u00a0]?234,50/);
    expect(formatMoneyMinor(123450, 'UAH', 'en')).toContain('1,234.50');
  });
});
