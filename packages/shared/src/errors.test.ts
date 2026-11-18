import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorCode } from './errors.js';

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const REGISTERED_CODE_COUNT = 34;

describe('error code registry', () => {
  it('uses UPPER_SNAKE format for every code', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(code).toMatch(UPPER_SNAKE);
    }
  });

  it('has unique code values', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('maps each key to the same string value', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('contains exactly the closed list from the registry', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(REGISTERED_CODE_COUNT);
  });

  it('exposes ErrorCode as a type that accepts registered codes', () => {
    const code: ErrorCode = ERROR_CODES.SLOT_TAKEN;
    expect(code).toBe('SLOT_TAKEN');
  });
});
