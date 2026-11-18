import { describe, expect, it } from 'vitest';
import HomePage from './page';

describe('HomePage', () => {
  it('is a component function', () => {
    expect(typeof HomePage).toBe('function');
  });
});
