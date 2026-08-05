import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from './agent-invalidation';

describe('invalidateAgentQueries', () => {
  it('invalidates every agent-derived prefix and leaves unrelated keys alone', async () => {
    const client = new QueryClient();
    const keys = [
      ['agents'],
      ['agents', 'options'],
      ['assistant', 'thread', 'x'],
      ['studio'],
      ['tasks'],
    ];
    for (const queryKey of keys) {
      client.setQueryData(queryKey, { seeded: true });
    }

    await invalidateAgentQueries(client);

    const isInvalidated = (queryKey: string[]) =>
      client.getQueryState(queryKey)?.isInvalidated ?? false;
    expect(isInvalidated(['agents'])).toBe(true);
    expect(isInvalidated(['agents', 'options'])).toBe(true);
    expect(isInvalidated(['assistant', 'thread', 'x'])).toBe(true);
    expect(isInvalidated(['studio'])).toBe(true);
    expect(isInvalidated(['tasks'])).toBe(false);
  });
});
