import { describe, expect, it } from 'vitest';

import { RECALL_BODY_CHAR_BUDGET, RECALL_MAX_MAP_NODES, recallSlug } from './recall-compile';

describe('recallSlug', () => {
  it('kebab-cases titles', () => {
    expect(recallSlug('Fleet, access & the MCP brains')).toBe('fleet-access-the-mcp-brains');
    expect(recallSlug('  ')).toBe('node');
  });

  it('strips accents and cuts at 60 characters with no trailing dash', () => {
    expect(recallSlug('Café Übersicht')).toBe('cafe-ubersicht');
    const long = recallSlug('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('the caps clients share', () => {
  it('holds the body budget and the card cap the editor counts against', () => {
    expect(RECALL_BODY_CHAR_BUDGET).toBe(6000);
    expect(RECALL_MAX_MAP_NODES).toBe(100);
  });
});
