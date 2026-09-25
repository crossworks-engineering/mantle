/**
 * What a team-member surface may read (member logins Phase 0).
 *
 * Team chat, the forum and a team-mode shared app run every tool under the
 * OWNER's id. Before this, the private-reads switch only removed the four
 * email_* / journal_* tools, so search_nodes, search_chunks, node_read,
 * read_section and the entity tools still returned email and journal rows to
 * a team member with the switch OFF. These pin the filter on each read path,
 * and the fail-closed default: a team surface with no flag hides the private
 * corpus.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Record<string, Array<Record<string, unknown>>> = {};
  return {
    calls,
    selectQueue: [] as unknown[][],
    teamApps: new Set<string>(),
    appQuery: vi.fn(async () => ({ rows: [{ a: 1 }], empty: false })),
    /** A stub that records the options it was called with. */
    record: (name: string, ret: unknown) =>
      vi.fn(async (args: Record<string, unknown>) => {
        (calls[name] ??= []).push(args);
        return ret;
      }),
  };
});

vi.mock('@mantle/search', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchNodes: h.record('searchNodes', []),
  searchChunks: h.record('searchChunks', []),
  readSection: h.record('readSection', { error: 'node not found' }),
  entityFacts: h.record('entityFacts', []),
  entityMentions: h.record('entityMentions', []),
  resolveSupersededTargets: vi.fn(async () => new Map()),
}));
vi.mock('@mantle/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2]) }));
vi.mock('@mantle/decisions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decisionUseEnabled: vi.fn(async () => null),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTeamSharedAppIds: vi.fn(async () => h.teamApps),
}));
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbReadQuery: h.appQuery,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => h.selectQueue.shift() ?? []),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});

import { surfaceHiddenNodeTypes } from './team-visibility';
import { BUILTIN_TOOLS } from './builtins';
import type { ToolHandlerContext } from './types';

const OWNER = 'owner-1';
const TEAM_OFF: ToolHandlerContext = {
  ownerId: OWNER,
  surface: { kind: 'team', contactId: 'c1' },
};
const TEAM_ON: ToolHandlerContext = {
  ownerId: OWNER,
  surface: { kind: 'team', contactId: 'c1', privateReads: true },
};
const OWNER_WEB: ToolHandlerContext = { ownerId: OWNER, surface: { kind: 'web' } };

const tool = (slug: string) => {
  const def = BUILTIN_TOOLS.find((t) => t.slug === slug);
  if (!def) throw new Error(`${slug} is not a builtin any more`);
  return def;
};

beforeEach(() => {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
  h.selectQueue.length = 0;
  h.teamApps = new Set();
  h.appQuery.mockClear();
});

describe('surfaceHiddenNodeTypes', () => {
  it('filters nothing on owner surfaces', () => {
    expect(surfaceHiddenNodeTypes(undefined)).toBeNull();
    expect(surfaceHiddenNodeTypes({ kind: 'web' })).toBeNull();
    expect(surfaceHiddenNodeTypes({ kind: 'telegram', telegramChatId: '1' })).toBeNull();
  });

  it('fails closed: a team surface with no flag hides email and journal', () => {
    const hidden = surfaceHiddenNodeTypes({ kind: 'team', contactId: 'c1' });
    expect(hidden).toEqual(expect.arrayContaining(['email', 'email_thread', 'journal']));
  });

  it('always hides secrets, Telegram chats, places and peers, even with the switch on', () => {
    for (const surface of [TEAM_ON.surface, TEAM_OFF.surface]) {
      expect(surfaceHiddenNodeTypes(surface)).toEqual(
        expect.arrayContaining(['secret', 'telegram_message', 'location', 'mantle_peer']),
      );
    }
    expect(surfaceHiddenNodeTypes(TEAM_ON.surface)).not.toContain('email');
  });

  it('treats the forum like team chat', () => {
    expect(surfaceHiddenNodeTypes({ kind: 'forum', contactId: 'c1', topicId: 't1' })).toContain(
      'journal',
    );
  });
});

describe('read tools on a team surface', () => {
  it('search_nodes asks the searcher to leave hidden types out', async () => {
    await tool('search_nodes').handler({ q: 'contract' }, TEAM_OFF);
    expect(h.calls.searchNodes![0]!.excludeTypes).toContain('email');
  });

  it('search_nodes passes no filter for the owner', async () => {
    await tool('search_nodes').handler({ q: 'contract' }, OWNER_WEB);
    expect(h.calls.searchNodes![0]!.excludeTypes).toBeUndefined();
  });

  it('search_chunks leaves hidden types out', async () => {
    await tool('search_chunks').handler({ q: 'contract' }, TEAM_OFF);
    expect(h.calls.searchChunks![0]!.excludeTypes).toContain('journal');
  });

  it('read_section leaves hidden types out', async () => {
    await tool('read_section').handler(
      { node_id: '00000000-0000-4000-8000-000000000001' },
      TEAM_OFF,
    );
    expect(h.calls.readSection![0]!.excludeTypes).toContain('email');
  });

  it('entity_facts and entity_mentions leave hidden sources out', async () => {
    const entity = { entity_id: '00000000-0000-4000-8000-000000000002' };
    await tool('entity_facts').handler(entity, TEAM_OFF);
    await tool('entity_mentions').handler(entity, TEAM_OFF);
    expect(h.calls.entityFacts![0]!.excludeSourceTypes).toContain('email');
    expect(h.calls.entityMentions![0]!.excludeTypes).toContain('email');
  });

  it('node_read answers "not found" for a hidden node, without confirming it exists', async () => {
    const row = {
      id: 'n1',
      type: 'email',
      title: 'Payslip',
      path: 'email',
      tags: [],
      data: { body: 'private' },
      supersededBy: null,
      supersededReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    h.selectQueue.push([row]);
    const hidden = await tool('node_read').handler({ node_id: 'n1' }, TEAM_OFF);
    expect(hidden.ok).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain('Payslip');

    h.selectQueue.push([row]);
    const owner = await tool('node_read').handler({ node_id: 'n1' }, OWNER_WEB);
    expect(owner.ok).toBe(true);
  });

  it('app_db_query refuses an app that is not shared with the team', async () => {
    const res = await tool('app_db_query').handler(
      { app_id: 'app-private', sql: 'select 1' },
      TEAM_OFF,
    );
    expect(res.ok && (res.output as { rows: unknown[] }).rows).toEqual([]);
    expect(h.appQuery).not.toHaveBeenCalled();
  });

  it('app_db_query reads an app that IS shared with the team', async () => {
    h.teamApps = new Set(['app-team']);
    await tool('app_db_query').handler({ app_id: 'app-team', sql: 'select 1' }, TEAM_OFF);
    expect(h.appQuery).toHaveBeenCalledOnce();
  });
});
