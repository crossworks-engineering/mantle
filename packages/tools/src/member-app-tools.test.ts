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

import { resolveTool } from './resolve';
import { BUILTIN_TOOLS } from './builtins';
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
        'extract_from_image',
        'team_request_create',
      ].sort(),
    );
  });

  it('refuses every builtin flagged `spends`, by the flag, before the group lookup (audit F17)', async () => {
    const spenders = BUILTIN_TOOLS.filter((t) => t.spends === true);
    expect(spenders.map((t) => t.slug)).toContain('extract_from_image');
    for (const def of spenders) {
      // A tool row under another slug over the spending builtin: the slug
      // list cannot catch it, the flag must.
      vi.mocked(resolveTool).mockResolvedValueOnce({
        slug: 'custom-alias',
        enabled: true,
        requiresConfirm: false,
        handler: { kind: 'builtin', ref: def.slug },
      } as never);
      const v = await memberAppToolVerdict('brain', ['custom-alias'], 'custom-alias');
      if (MEMBER_APP_REFUSED_SLUGS.includes(def.slug)) {
        expect(v, def.slug).toMatchObject({ ok: false, status: 403 });
      } else {
        expect(v, def.slug).toMatchObject({
          ok: false,
          status: 403,
          reason: expect.stringMatching(/paid model work/),
        });
      }
    }
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
