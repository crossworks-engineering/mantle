import { describe, expect, it } from 'vitest';
import { TEAM_REQUEST_TAG as CONTENT_TEAM_REQUEST_TAG } from '@mantle/content';
import { TEAM_TOOLS, TEAM_REQUEST_TAG } from './builtins-team';
import type { ToolHandlerContext } from './types';

/**
 * Surface gating for the team tools — the boundary that keeps the two sides
 * apart. These paths must refuse BEFORE any data access:
 *   - team_request_create runs ONLY on the team surface (provenance comes
 *     from the authenticated surface context, so off-surface calls are
 *     meaningless and refused);
 *   - the owner-side team_chat_* / team_access_list tools must refuse ON the
 *     team surface — granting them to the team responder by mistake would
 *     leak other members' threads, and this gate is the backstop even then.
 */

const bySlug = Object.fromEntries(TEAM_TOOLS.map((t) => [t.slug, t]));

const ownerCtx: ToolHandlerContext = { ownerId: 'owner-1', surface: { kind: 'web' } };
const teamCtx: ToolHandlerContext = {
  ownerId: 'owner-1',
  surface: { kind: 'team', contactId: 'contact-9', contactName: 'Sam' },
};

describe('team_request_create surface gate', () => {
  it('refuses off the team surface (web)', async () => {
    const r = await bySlug.team_request_create!.handler({ title: 't', body: 'b' }, ownerCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Team Chat surface/i);
  });

  it('refuses with no surface at all (background callers)', async () => {
    const r = await bySlug.team_request_create!.handler(
      { title: 't', body: 'b' },
      { ownerId: 'owner-1' },
    );
    expect(r.ok).toBe(false);
  });

  it('requires title and body before touching anything', async () => {
    const r = await bySlug.team_request_create!.handler({ title: '  ' }, teamCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/title and body/i);
  });
});

describe('owner-side team tools refuse on the team surface', () => {
  for (const slug of ['team_chat_list', 'team_chat_read', 'team_access_list'] as const) {
    it(`${slug} refuses`, async () => {
      const r = await bySlug[slug]!.handler({ contactId: 'contact-9' }, teamCtx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/owner-side/i);
    });
  }
});

describe('team-request tag', () => {
  it('is the same literal the content requests view filters on (no drift)', () => {
    // team_request_create tags with this; listTeamRequests filters on it. They
    // live in different packages, so lock them together.
    expect(TEAM_REQUEST_TAG).toBe(CONTENT_TEAM_REQUEST_TAG);
    expect(TEAM_REQUEST_TAG).toBe('team-request');
  });
});
