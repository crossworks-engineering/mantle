import { describe, expect, it } from 'vitest';
import { isPublicToolAllowed } from './readonly-tools';

describe('isPublicToolAllowed', () => {
  it('grants NO brain tools to anonymous public-share visitors', () => {
    // The whole brain is private and every read tool reaches it by content, so
    // public mode allows zero brain tools — a public app is confined to its own
    // sqlite (query-only db-broker). This must stay `false`.
    expect(isPublicToolAllowed()).toBe(false);
  });
});
