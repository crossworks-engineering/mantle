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
import { memberAppRefusedName, memberAppToolVerdict } from './member-app-tools';
// The access lists are views of the tool policy table, which the registry
// fills (A5): load it.
import './registry';

/** The names no team app calls: the retired team tools and the builtins
 *  whose policy refuses a team app (A5 step 6a: no MEMBER_APP_REFUSED_SLUGS
 *  view; memberAppRefusedName reads the policy). */
const REFUSED = [
  'my_item_open',
  'my_items_list',
  'read_result',
  'search_chunks',
  'summarize_text',
  'extract_from_image',
  'team_request_create',
];

describe('memberAppToolVerdict refused list', () => {
  it('holds the private-item readers, the LLM spenders and the chat-only tools', () => {
    for (const slug of REFUSED) expect(memberAppRefusedName(slug), slug).toBe(true);
    const others = BUILTIN_TOOLS.filter((t) => !REFUSED.includes(t.slug));
    for (const t of others) expect(memberAppRefusedName(t.slug), t.slug).toBe(false);
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
      if (REFUSED.includes(def.slug)) {
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
    for (const slug of REFUSED) {
      expect(await memberAppToolVerdict('brain', [slug], slug), slug).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });
});
