import { describe, expect, it } from 'vitest';
import uk from '../../messages/uk.json';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';

describe('message catalogs', () => {
  it('have the same keys in every locale', () => {
    const keys = (o: object) => JSON.stringify(Object.keys(o).sort());
    expect(keys(en)).toBe(keys(uk));
    expect(keys(pl)).toBe(keys(uk));
  });
});
