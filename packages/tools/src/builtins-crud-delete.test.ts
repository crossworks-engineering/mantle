/**
 * Behavioural tests for the five single-entity delete tools — note_delete,
 * task_delete, event_delete, journal_delete, contact_delete. None had one.
 *
 * They share a shape: guard the id, call the store, and translate a `false`
 * return into "not found". So they share a failure mode, and it is the one
 * that matters — a store that deleted nothing returning a tool result that
 * reads like success. The model then tells the user their note is gone and
 * moves on, and nothing anywhere disagrees.
 *
 * Each store call is stubbed; the tools' own guards and translation are real.
 *
 * Two properties beyond the per-tool arms:
 *
 *  - `journal_delete` and `contact_delete` are confirm-gated, and both are
 *    deliberately ABSENT from their package's AUTO_GRANT list. That pairing is
 *    the actual protection: the gate stops an unattended call, and the
 *    exclusion stops a conversational agent from holding the tool at all.
 *  - `contact_delete` severs the email allowlist in BOTH directions, which is
 *    invisible from the phrase "remove X from my contacts". Its gate is the
 *    only thing making that deliberate.
 *
 * Noted, not changed: `note_delete` answers `'not found'` / `'id required'`
 * rather than using the package's own `notFound(kind, id, lookup)` helper, so
 * it is the one tool here that does not tell the caller which lookup would fix
 * it (packages/tools/CLAUDE.md, "The error style guide"). It is `mcpOnly`, so
 * only the owner ever sees it. The tests below assert what it DOES, not what
 * the style guide would prefer.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    deleteNote: vi.fn(),
    deleteTask: vi.fn(),
    deleteEvent: vi.fn(),
    deleteJournal: vi.fn(),
    deleteContact: vi.fn(),
  };
});

import { deleteNote, deleteTask, deleteEvent, deleteJournal, deleteContact } from '@mantle/content';
import { NOTE_OPERATOR_TOOLS } from './builtins-notes';
import { TASK_TOOLS } from './builtins-tasks';
import { EVENT_TOOLS } from './builtins-events';
import { JOURNAL_TOOLS, JOURNAL_AUTO_GRANT_SLUGS } from './builtins-journal';
import { CONTACT_TOOLS, CONTACT_AUTO_GRANT_SLUGS } from './builtins-contacts';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';

const noteDel = NOTE_OPERATOR_TOOLS.find((t) => t.slug === 'note_delete')!;
const taskDel = TASK_TOOLS.find((t) => t.slug === 'task_delete')!;
const eventDel = EVENT_TOOLS.find((t) => t.slug === 'event_delete')!;
const journalDel = JOURNAL_TOOLS.find((t) => t.slug === 'journal_delete')!;
const contactDel = CONTACT_TOOLS.find((t) => t.slug === 'contact_delete')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): unknown {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output;
}

beforeEach(() => vi.clearAllMocks());

/**
 * The shared contract, driven once per tool. `store` is the stubbed delete;
 * `lookupHint` is the tool a caller should reach for after a miss — every one
 * of these names one except note_delete, which is why it passes `null`.
 */
const CASES: {
  name: string;
  tool: BuiltinToolDef;
  store: ReturnType<typeof vi.fn>;
  lookupHint: RegExp | null;
}[] = [
  { name: 'note_delete', tool: noteDel, store: vi.mocked(deleteNote), lookupHint: null },
  { name: 'task_delete', tool: taskDel, store: vi.mocked(deleteTask), lookupHint: /task_list/ },
  { name: 'event_delete', tool: eventDel, store: vi.mocked(deleteEvent), lookupHint: /event_list/ },
  {
    name: 'journal_delete',
    tool: journalDel,
    store: vi.mocked(deleteJournal),
    lookupHint: /journal_list/,
  },
  {
    name: 'contact_delete',
    tool: contactDel,
    store: vi.mocked(deleteContact),
    lookupHint: /contact_find|contact_list/,
  },
];

describe.each(CASES)('$name', ({ tool, store, lookupHint }) => {
  it('refuses a blank id WITHOUT calling the store', async () => {
    const res = await tool.handler({ id: '' }, ctx);
    expect(errorOf(res)).toMatch(/id/i);
    // The guard exists so a missing id can never reach a delete as `undefined`
    // and match something unintended.
    expect(store).not.toHaveBeenCalled();
  });

  it('reports a miss as a failure, never as a deletion', async () => {
    store.mockResolvedValue(false);
    const res = await tool.handler({ id: ID }, ctx);
    // THE property. A `false` return means nothing was removed; anything that
    // reads as success here tells the user their data is gone when it is not.
    expect(errorOf(res)).toMatch(/not found/i);
  });

  it('passes the owner and id through to the store on the happy path', async () => {
    store.mockResolvedValue(true);
    const res = await tool.handler({ id: ID }, ctx);
    expect(store).toHaveBeenCalledWith('o1', ID);
    expect(outputOf(res)).toBeTruthy();
  });

  if (lookupHint) {
    it('names the lookup tool that would fix a bad id', async () => {
      store.mockResolvedValue(false);
      // The package's error style guide: an error should carry the recovery
      // move, not just the verdict.
      expect(errorOf(await tool.handler({ id: ID }, ctx))).toMatch(lookupHint);
    });
  }
});

describe('destructive tools are gated AND ungrantable, not one or the other', () => {
  it('journal_delete is confirm-gated and excluded from the journal auto-grant', () => {
    expect(journalDel.requiresConfirm).toBe(true);
    // The gate stops an unattended call; the exclusion stops a conversational
    // agent from holding the tool at all. Losing either leaves a hole.
    expect(JOURNAL_AUTO_GRANT_SLUGS).not.toContain('journal_delete');
  });

  it('contact_delete is confirm-gated and excluded from the contact auto-grant', () => {
    expect(contactDel.requiresConfirm).toBe(true);
    expect(CONTACT_AUTO_GRANT_SLUGS).not.toContain('contact_delete');
  });

  it('the auto-grant lists still contain their READ tools', () => {
    // Guards the assertions above against passing for the wrong reason — an
    // empty or renamed list would satisfy "does not contain" trivially.
    expect(JOURNAL_AUTO_GRANT_SLUGS).toContain('journal_list');
    expect(CONTACT_AUTO_GRANT_SLUGS).toContain('contact_list');
  });

  it('contact_delete still warns that it severs the email allowlist', () => {
    // The side effect is invisible from "remove X from my contacts", and the
    // description is the only place the model is told. Losing this sentence
    // loses the warning entirely.
    expect(contactDel.description).toMatch(/allowlist/i);
  });
});
