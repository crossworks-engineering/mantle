import { describe, expect, it } from 'vitest';
import { matchGoldKeys, type GoldKeyRow } from './gold-keys';

const row = (id: string, type: string, title_key: string | null, body_key: string | null) =>
  ({ id, type, title_key, body_key }) satisfies GoldKeyRow;

const ROWS = [
  row('n1', 'page', 't-plan', 'b-plan'),
  // The same item made again with a new id: same keys.
  row('n1-again', 'page', 't-plan', 'b-plan'),
  row('n2', 'note', 't-plan', null),
  row('n3', 'page', null, 'b-other'),
];

describe('matchGoldKeys', () => {
  it('matches by title key within the type, so a re-made item still counts', () => {
    expect(matchGoldKeys([{ type: 'page', titleKey: 't-plan' }], ROWS)).toEqual(['n1', 'n1-again']);
  });
  it('matches by body key alone', () => {
    expect(matchGoldKeys([{ type: 'page', bodyKey: 'b-other' }], ROWS)).toEqual(['n3']);
  });
  it('either key is enough', () => {
    expect(
      matchGoldKeys([{ type: 'page', titleKey: 'no-such', bodyKey: 'b-other' }], ROWS),
    ).toEqual(['n3']);
  });
  it('never matches across types', () => {
    expect(matchGoldKeys([{ type: 'note', bodyKey: 'b-plan' }], ROWS)).toEqual([]);
  });
  it('a null or empty key names nothing, even against a row whose key is null', () => {
    expect(matchGoldKeys([{ type: 'page', titleKey: null, bodyKey: null }], ROWS)).toEqual([]);
    expect(matchGoldKeys([{ type: 'page', titleKey: '' }], ROWS)).toEqual([]);
  });
});
