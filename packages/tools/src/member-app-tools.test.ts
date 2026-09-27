/**
 * The member tool rule's refused list (member logins Phase 4b): every slug on
 * it is refused before any lookup, whatever the app declares. The rest of the
 * rule is proven on Postgres in member-app-tools.viewer.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async () => {
    throw new Error('a refused slug must be refused before any lookup');
  }),
}));

import { MEMBER_APP_REFUSED_SLUGS, memberAppToolVerdict } from './member-app-tools';

describe('memberAppToolVerdict refused list', () => {
  it('holds the private-item readers, the LLM spenders and the chat-only tools', () => {
    expect([...MEMBER_APP_REFUSED_SLUGS].sort()).toEqual(
      [
        'my_item_open',
        'my_items_list',
        'read_result',
        'search_chunks',
        'summarize_text',
        'team_request_create',
      ].sort(),
    );
  });

  it('refuses every refused slug even when the app declares it', async () => {
    for (const slug of MEMBER_APP_REFUSED_SLUGS) {
      expect(await memberAppToolVerdict('brain', [slug], slug), slug).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });
});
