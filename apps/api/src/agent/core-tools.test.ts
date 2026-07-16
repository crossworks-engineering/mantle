import { describe, it, expect } from 'vitest';
import { CORE_AUTO_GRANT_GROUP_SLUGS, computeFloorGroupAdditions } from './core-tools';

/**
 * The boot self-heal floor (apps/agent ensureCoreToolsOnConversationalAgents).
 * These pin two things the audit flagged (docs/audit-brief-tools-skills.md R5):
 *   1. the floor is SUFFICIENT to stand up a correct persona — it must confer
 *      `invoke_agent` (else the integrity persona check fails) and `memory-core`
 *      search (else the agent can't ground answers);
 *   2. the grant logic is idempotent + coverage-aware and never re-grants.
 */

/** A group→tools map mirroring the relevant MANIFEST_TOOL_GROUPS members. Only
 *  the tools the assertions care about are listed; that's all the logic reads. */
const GROUP_TOOLS = new Map<string, readonly string[]>([
  ['persona', ['update_persona']],
  ['tasks', ['task_list', 'task_get', 'task_create', 'task_update', 'task_delete']],
  ['contacts', ['contact_create', 'contact_find', 'contact_get', 'contact_list', 'contact_update']],
  ['journal', ['journal_create', 'journal_get', 'journal_list', 'journal_update']],
  ['notes', ['note_create', 'note_list', 'note_get']],
  ['email', ['email_send', 'email_page', 'email_list', 'email_get']],
  ['page-share', ['page_share', 'page_unshare']],
  ['memory-core', ['search_nodes', 'search_chunks', 'tree_list', 'node_read', 'entity_search']],
  ['delegation', ['invoke_agent']],
  // A few non-floor groups, to exercise the coverage path.
  ['files', ['file_list', 'file_get', 'file_read', 'file_create']],
  ['recall', ['recall_window']],
]);

describe('CORE_AUTO_GRANT_GROUP_SLUGS — floor membership', () => {
  it('includes the two groups that make a persona correct: memory-core + delegation', () => {
    expect(CORE_AUTO_GRANT_GROUP_SLUGS).toContain('memory-core');
    expect(CORE_AUTO_GRANT_GROUP_SLUGS).toContain('delegation');
  });

  it('expands to a tool set that passes the persona integrity gate', () => {
    const tools = new Set<string>();
    for (const g of CORE_AUTO_GRANT_GROUP_SLUGS)
      for (const t of GROUP_TOOLS.get(g) ?? []) tools.add(t);
    // integrity.ts check 1: persona must be able to delegate + actually act.
    expect(tools.has('invoke_agent')).toBe(true);
    // tool_grounding skill: the agent must be able to search the brain.
    expect(tools.has('search_nodes')).toBe(true);
    expect(tools.has('node_read')).toBe(true);
  });

  it('stays lean — no email/secrets/media over-grant beyond the functional minimum', () => {
    // The floor must NOT pull in the richer generalist groups (those are opt-in /
    // manifest-seeded), so a locked-down custom responder isn't blasted with them.
    for (const g of ['secrets', 'ingest', 'media-workers', 'events', 'recall', 'files']) {
      expect(CORE_AUTO_GRANT_GROUP_SLUGS).not.toContain(g);
    }
  });
});

describe('computeFloorGroupAdditions', () => {
  it('grants the whole floor to an agent that holds nothing', () => {
    const add = computeFloorGroupAdditions(new Set(), GROUP_TOOLS);
    expect(add).toEqual([...CORE_AUTO_GRANT_GROUP_SLUGS]);
  });

  it('is idempotent — an agent already holding the floor gets nothing added', () => {
    const have = new Set(CORE_AUTO_GRANT_GROUP_SLUGS);
    expect(computeFloorGroupAdditions(have, GROUP_TOOLS)).toEqual([]);
  });

  it('adds only the missing floor groups', () => {
    const have = new Set(['persona', 'tasks', 'memory-core', 'delegation']);
    const add = computeFloorGroupAdditions(have, GROUP_TOOLS);
    expect(add).toEqual(['contacts', 'journal', 'notes', 'email', 'page-share']);
  });

  it('skips a floor group whose tools are already fully covered by another grant', () => {
    // A custom group conferring every note tool means `notes` adds nothing new.
    const tools = new Map(GROUP_TOOLS);
    tools.set('my-notes-superset', ['note_create', 'note_list', 'note_get', 'extra']);
    const have = new Set(['my-notes-superset']);
    const add = computeFloorGroupAdditions(have, tools);
    expect(add).not.toContain('notes');
    expect(add).toContain('tasks'); // still missing, still added
  });

  it('skips a floor group that is missing/disabled (no enabled row in the map)', () => {
    // Simulate `email` disabled: absent from the enabled-groups map. It cannot be
    // granted (length 0) and must be silently skipped, not crash.
    const tools = new Map(GROUP_TOOLS);
    tools.delete('email');
    const add = computeFloorGroupAdditions(new Set(), tools);
    expect(add).not.toContain('email');
    expect(add).toContain('memory-core');
  });
});
