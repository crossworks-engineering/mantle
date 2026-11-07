/**
 * A ui tool's trace steps hold the action and the outcome code only
 * (docs/agent-ui.md, "What a member's agent sees, and where it goes"): the tool step its
 * slug, never the arguments (a target's name, a caption, an option, a path,
 * typed text), the raw arguments of a failed parse or a window's message;
 * another tool's step keeps its redacted arguments and its error as before.
 * The same tool loop runs both engines (run-turn.ts, run-team-turn.ts). No
 * database: the trace step and the dispatch are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Recorded = {
  input: unknown;
  error?: string;
  meta: unknown[];
};

const h = vi.hoisted(() => ({
  steps: [] as Array<{ input: unknown; error?: string; meta: unknown[] }>,
  result: { ok: true } as { ok: true; output?: unknown } | { ok: false; error: string },
  dispatched: 0,
}));

vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  step: async (
    o: { input: unknown },
    fn: (h: {
      setError: (e: string) => void;
      setMeta: (m: unknown) => void;
      setOutput: (o: unknown) => void;
      setSkipped: (r: string) => void;
    }) => Promise<unknown>,
  ) => {
    const rec: Recorded = { input: o.input, meta: [] };
    h.steps.push(rec);
    return fn({
      setError: (e) => {
        rec.error = e;
      },
      setMeta: (m) => rec.meta.push(m),
      setOutput: () => {},
      setSkipped: () => {},
    });
  },
}));

vi.mock('@mantle/tools', async (orig) => ({
  ...(await orig<typeof import('@mantle/tools')>()),
  dispatchTool: vi.fn(
    async (_t: unknown, _i: unknown, ctx: { step?: { setMeta: (m: unknown) => void } }) => {
      h.dispatched += 1;
      // A tool that records what it did, with free text (an email's to).
      ctx.step?.setMeta({ to: 'Pat Jones', n: 1 });
      return h.result;
    },
  ),
  turnCaller: () => ({}),
}));

const LESSON_PAGE = '99999999-9999-4999-8999-999999999991';
const OTHER = '99999999-9999-4999-8999-999999999993';
const NESTED = '99999999-9999-4999-8999-999999999994';
vi.mock('@mantle/tools/lessons', async (orig) => ({
  ...(await orig<typeof import('@mantle/tools/lessons')>()),
  lessonItemIn: async (_o: string, ids: readonly unknown[]) => ids.includes(LESSON_PAGE),
  // NESTED is a folder named "Lessons" deeper in Pages (or one holding it).
  folderHoldsLessonsName: async (_o: string, id: string) => id === NESTED,
}));

const { executeToolCall } = await import('./execute-call');
const { registerAgentUiTools } = await import('../../agent-ui');
registerAgentUiTools();

const { withoutText } = await import('./execute-call');
const SECRETS = ['Q3 salaries', 'Pat Jones', 'hunter2', '/files/private', 'Dark mode', 'Payroll'];

function run(
  slug: string,
  input: Record<string, unknown>,
  raw?: string,
  parseError?: string,
  tainted = false,
) {
  return executeToolCall({
    args: { ownerId: 'o' } as never,
    slug,
    call: { id: 'call_1', function: { name: slug, arguments: raw ?? JSON.stringify(input) } },
    tool: { slug, requiresConfirm: false, handler: { kind: 'builtin', ref: slug } } as never,
    input,
    argParseError: parseError ?? null,
    argValidation: null,
    argValidationMode: 'warn' as never,
    lastUserMessage: undefined,
    pendingIds: [],
    ...(tainted ? { taint: { clientSourced: true, via: 'a client comment' } } : {}),
  });
}

const dump = () => JSON.stringify(h.steps);

beforeEach(() => {
  h.steps = [];
  h.result = { ok: true };
  h.dispatched = 0;
});

describe('a ui tool step holds no names or text', () => {
  it('a call: its slug only, whatever the arguments (known fields or not)', async () => {
    await run('ui_type', {
      target: { role: 'textbox', name: 'Q3 salaries' },
      text: 'hunter2',
      replace: true,
      note: 'Pat Jones',
    });
    await run('ui_select', { target: { id: 'Payroll' }, option: 'Dark mode' });
    await run('ui_navigate', { path: '/files/private' });
    await run('ui_point', { target: { ref: 'e1' }, caption: 'Pat Jones' });
    expect(h.steps.map((s) => s.input)).toEqual([
      { slug: 'ui_type' },
      { slug: 'ui_select' },
      { slug: 'ui_navigate' },
      { slug: 'ui_point' },
    ]);
    for (const s of SECRETS) expect(dump()).not.toContain(s);
  });

  it("a window's refusal: its code, never its message", async () => {
    h.result = { ok: false, error: 'not_found: no button "Pat Jones" on Q3 salaries' };
    await run('ui_click', { target: { role: 'button', name: 'Pat Jones' } });
    expect(h.steps[0]!.error).toBe('not_found');
    // A code that is not one (free text before the colon) is kept as `error`.
    h.result = { ok: false, error: 'Pat Jones said no: nope' };
    await run('ui_click', { target: { ref: 'e2' } });
    expect(h.steps[1]!.error).toBe('error');
    for (const s of SECRETS) expect(dump()).not.toContain(s);
  });

  it('a failed parse: no raw arguments, a code', async () => {
    await run(
      'ui_type',
      {},
      '{"text":"hunter2", "target": {"name": "Pat Jones"',
      'bad JSON near "hunter2"',
    );
    expect(h.steps[0]!).toEqual({ input: { slug: 'ui_type' }, error: 'bad_arguments', meta: [] });
  });

  it('another tool keeps its redacted arguments and its error as before', async () => {
    h.result = { ok: false, error: 'not found: page Payroll' };
    await run('page_get', { id: 'Payroll' });
    expect(h.steps[0]!.input).toEqual({ slug: 'page_get', args: { id: 'Payroll' } });
    expect(h.steps[0]!.error).toBe('not found: page Payroll');
  });
});

describe('a tainted turn (it read text a client wrote): the acting ui tools follow the write rule', () => {
  it('ui_click, ui_type and ui_select are refused at once, never queued, never run', async () => {
    const pending: string[] = [];
    for (const [slug, input] of [
      ['ui_click', { target: { ref: 'e1' } }],
      ['ui_type', { target: { ref: 'e2' }, text: 'shared with the client now' }],
      ['ui_select', { target: { ref: 'e3' }, option: 'Public' }],
    ] as const) {
      const res = await executeToolCall({
        args: { ownerId: 'o' } as never,
        slug,
        call: { id: 'c', function: { name: slug, arguments: JSON.stringify(input) } },
        tool: { slug, requiresConfirm: false, handler: { kind: 'builtin', ref: slug } } as never,
        input: input as Record<string, unknown>,
        argParseError: null,
        argValidation: null,
        argValidationMode: 'warn' as never,
        lastUserMessage: undefined,
        pendingIds: pending,
        taint: { clientSourced: true, via: 'a client comment' },
      });
      expect(res.ok, slug).toBe(false);
      expect(!res.ok && res.error, slug).toMatch(/^needs_user: this turn read text a client wrote/);
    }
    expect(h.dispatched).toBe(0);
    expect(pending).toEqual([]);
    // The trace keeps the code only.
    expect(h.steps.map((s) => s.error)).toEqual(['needs_user', 'needs_user', 'needs_user']);
    expect(dump()).not.toContain('shared with the client now');
  });

  it('ui_screen, ui_navigate, ui_point and ui_wait stay free on a tainted turn', async () => {
    await run('ui_screen', {}, undefined, undefined, true);
    await run('ui_navigate', { path: '/pages' }, undefined, undefined, true);
    await run('ui_point', { target: { ref: 'e1' }, caption: 'here' }, undefined, undefined, true);
    await run('ui_wait', { ms: 10 }, undefined, undefined, true);
    expect(h.dispatched).toBe(4);
  });

  it('an untainted turn runs the acting tools as before', async () => {
    await run('ui_click', { target: { ref: 'e1' } });
    await run('ui_type', { target: { ref: 'e1' }, text: 'hi' });
    expect(h.dispatched).toBe(2);
  });
});

describe('after a ui tool ran in the turn, every later tool step keeps its slug and code only', () => {
  const after = (slug: string, input: Record<string, unknown>) =>
    executeToolCall({
      args: { ownerId: 'o' } as never,
      slug,
      call: { id: 'c', function: { name: slug, arguments: JSON.stringify(input) } },
      tool: { slug, requiresConfirm: false, handler: { kind: 'builtin', ref: slug } } as never,
      input,
      argParseError: null,
      argValidation: null,
      argValidationMode: 'warn' as never,
      lastUserMessage: undefined,
      pendingIds: [],
      afterWindow: true,
    });

  it("another tool's arguments and error text are left out", async () => {
    h.result = { ok: false, error: 'not_found: no page named Q3 salaries' };
    await after('search', { query: 'Pat Jones Q3 salaries' });
    // The tool's own meta keeps its numbers only (withoutText).
    expect(h.steps[0]).toEqual({ input: { slug: 'search' }, error: 'not_found', meta: [{ n: 1 }] });
    for (const s of SECRETS) expect(dump()).not.toContain(s);
  });

  it('before any ui tool, the same call keeps its arguments as before', async () => {
    await run('search', { query: 'Payroll' });
    expect(h.steps[0]!.input).toEqual({ slug: 'search', args: { query: 'Payroll' } });
  });
});

describe("a lesson is edited by people: an agent turn's page tools refuse one", () => {
  it('a page or draft tool on a lesson page is refused before it runs; another page runs', async () => {
    for (const [slug, input] of [
      ['page_update', { id: LESSON_PAGE, markdown: 'x' }],
      ['page_update_draft', { id: LESSON_PAGE, markdown: 'x' }],
      ['page_block_append', { page_id: LESSON_PAGE, markdown: 'x' }],
      ['page_create', { title: 'x', folder_id: LESSON_PAGE }],
    ] as const) {
      const res = await run(slug, input as Record<string, unknown>);
      expect(res.ok, slug).toBe(false);
      expect(!res.ok && res.error, slug).toMatch(/^lesson_page: .*lessons are edited by people/);
    }
    expect(h.dispatched).toBe(0);
    await run('page_update', { id: '99999999-9999-4999-8999-999999999992', markdown: 'x' });
    expect(h.dispatched).toBe(1);
  });

  it('an id is read as the handlers read it: trimmed, any case; one that is no uuid is refused', async () => {
    const padded = await run('page_update', {
      id: ` ${LESSON_PAGE.toUpperCase()}\n`,
      markdown: 'x',
    });
    expect(!padded.ok && padded.error).toMatch(/^lesson_page: /);
    const bad = await run('page_update', { id: 'the lesson page', markdown: 'x' });
    expect(!bad.ok && bad.error).toMatch(/^bad_arguments: .*not an id/);
    const badInList = await run('tree_item_move', {
      kind: 'pages',
      item_ids: [OTHER, 'x'],
      folder_id: OTHER,
    });
    expect(!badInList.ok && badInList.error).toMatch(/^bad_arguments: /);
    expect(h.dispatched).toBe(0);
  });

  it('a tree tool renames no folder to or from "Lessons" and moves nothing into or out of it', async () => {
    for (const [slug, input] of [
      // Into the Lessons folder, and out of it (a list names the lesson).
      ['tree_item_move', { kind: 'pages', item_ids: [OTHER], folder_id: LESSON_PAGE }],
      ['tree_item_move', { kind: 'pages', item_ids: [OTHER, LESSON_PAGE], folder_id: null }],
      // A folder moved in, or the Lessons folder moved, renamed or deleted.
      ['tree_folder_update', { kind: 'pages', folder_id: OTHER, parent_id: LESSON_PAGE }],
      ['tree_folder_update', { kind: 'pages', folder_id: LESSON_PAGE, name: 'Old lessons' }],
      ['tree_folder_delete', { kind: 'pages', folder_id: LESSON_PAGE }],
      ['tree_folder_create', { kind: 'pages', name: 'A unit', parent_id: LESSON_PAGE }],
    ] as const) {
      const res = await run(slug, input as Record<string, unknown>);
      expect(!res.ok && res.error, JSON.stringify(input)).toMatch(
        /^lesson_page: this page is a lesson/,
      );
    }
    // Another folder renamed to "Lessons", or a new one so named, any case.
    for (const [slug, input] of [
      ['tree_folder_update', { kind: 'pages', folder_id: OTHER, name: '  lessons ' }],
      ['tree_folder_create', { kind: 'pages', name: 'LESSONS' }],
    ] as const) {
      const res = await run(slug, input as Record<string, unknown>);
      expect(!res.ok && res.error, JSON.stringify(input)).toMatch(
        /^lesson_page: "Lessons" is the name/,
      );
    }
    expect(h.dispatched).toBe(0);
    // A folder named "Lessons" deeper in Pages, or one holding it, moved to
    // the top would become the lessons folder.
    for (const parent_id of [null, '', ' ']) {
      const res = await run('tree_folder_update', { kind: 'pages', folder_id: NESTED, parent_id });
      expect(!res.ok && res.error, String(parent_id)).toMatch(
        /^lesson_page: a folder named "Lessons"/,
      );
    }
    expect(h.dispatched).toBe(0);
    // Moved under another folder it runs, and so does another folder to the top.
    await run('tree_folder_update', { kind: 'pages', folder_id: NESTED, parent_id: OTHER });
    await run('tree_folder_update', { kind: 'pages', folder_id: OTHER, parent_id: null });
    expect(h.dispatched).toBe(2);
    h.dispatched = 0;
    // Another name, or another kind's folder, runs.
    await run('tree_folder_update', { kind: 'pages', folder_id: OTHER, name: 'Lessons 2' });
    await run('tree_folder_create', { kind: 'notes', name: 'Lessons' });
    await run('tree_item_move', { kind: 'pages', item_ids: [OTHER], folder_id: OTHER });
    expect(h.dispatched).toBe(3);
  });
});

describe('once the turn saw the window, a step keeps no free text in its meta or output', () => {
  it('withoutText keeps numbers and yes or no only', () => {
    expect(
      withoutText({
        to: 'pat@example.invalid',
        subject: 'Q3 salaries',
        count: 2,
        sent: true,
        ids: ['a'],
      }),
    ).toEqual({ count: 2, sent: true });
    expect(withoutText(null)).toEqual({});
    expect(withoutText(['x'] as never)).toEqual({});
  });
});

describe("a tool's own meta after the window", () => {
  it('keeps no free text once the turn saw the window, and all of it before', async () => {
    await executeToolCall({
      args: { ownerId: 'o' } as never,
      slug: 'email_send',
      call: { id: 'c', function: { name: 'email_send', arguments: '{}' } },
      tool: {
        slug: 'email_send',
        requiresConfirm: false,
        handler: { kind: 'builtin', ref: 'email_send' },
      } as never,
      input: {},
      argParseError: null,
      argValidation: null,
      argValidationMode: 'warn' as never,
      lastUserMessage: undefined,
      pendingIds: [],
      afterWindow: true,
    });
    expect(h.steps[0]!.meta).toEqual([{ n: 1 }]);
    await run('search', { query: 'x' });
    expect(h.steps[1]!.meta).toEqual([{ to: 'Pat Jones', n: 1 }]);
  });
});
