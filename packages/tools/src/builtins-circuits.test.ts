/**
 * circuit_trace's rights, without a database: the tables come from the
 * caller's scoped list, and a table the caller cannot open (tableSqlSurface
 * answers null, as it does for a table its scope does not read) is never
 * queried, so none of its rows reach the trace. The same on a real
 * Postgres with row level security: builtins-circuits.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => ({
  rows: [] as { id: string; title: string; data: unknown; fileSha?: string }[],
}));
const surfaces = vi.hoisted(() => ({ readable: new Set<string>(), opened: [] as string[] }));
const sqlCalls = vi.hoisted(() => ({ files: [] as string[] }));
/** When set, the layout of the drawing's first page is made to fail, as a
 *  template bug would: pid_check must say so with the page's path. */
const layout = vi.hoisted(() => ({ fail: false }));

vi.mock('@mantle/diagram-templates', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/diagram-templates')>();
  return {
    ...real,
    render: (...args: Parameters<typeof real.render>) => {
      const out = real.render(...args);
      if (!layout.fail || !out.ok) return out;
      return { ...out, failed: [{ page: 'p1', path: 'pages[0].data', error: 'made to fail' }] };
    },
  };
});

vi.mock('@mantle/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => listed.rows,
  };
  return {
    db: chain,
    nodes: {
      id: 'id',
      title: 'title',
      data: 'data',
      ownerId: 'owner_id',
      type: 'type',
      tags: 'tags',
      updatedAt: 'updated_at',
    },
  };
});
vi.mock('@mantle/content', () => ({ nodeUrl: (id: string) => `https://brain.test/n/${id}` }));
vi.mock('@mantle/content/table-storage', () => ({
  tableSqlSurface: async (_owner: string, id: string) => {
    surfaces.opened.push(id);
    if (!surfaces.readable.has(id)) return null;
    return {
      abs: `/tables/${id}.sqlite`,
      draftAbs: null,
      draftOk: false,
      tabs: ['Layers', 'Segments', 'Nodes', 'Circuits'].map((name) => ({ name, viewName: name })),
    };
  },
}));
vi.mock('@mantle/tabledb', () => ({
  runTableSql: async (file: string, q: string) => {
    sqlCalls.files.push(file);
    // A table whose workbook file is not there (another box's, a lost file).
    if (file.includes('broken')) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    if (q.includes('FROM "Layers"'))
      return { columns: ['l'], rows: [['Circuit 10000-001-01']], truncated: false };
    if (q.includes('FROM "Segments"') && q.includes('IN (')) {
      return {
        columns: [],
        rows: [['Circuit 10000-001-01', 'A1', 0, 0, 10, 0, 10, 1, 2]],
        truncated: false,
      };
    }
    if (q.includes('FROM "Nodes"') && q.includes('"Node" IN')) {
      return {
        columns: [],
        rows: [
          [1, 0, 0, 1, 'end', '', '', 'Circuit 10000-001-01'],
          [2, 10, 0, 1, 'end', '', '', 'Circuit 10000-001-01'],
        ],
        truncated: false,
      };
    }
    return { columns: [], rows: [], truncated: false };
  },
}));

import {
  CIRCUIT_TOOLS,
  circuitTraceHandler,
  circuitVerifyHandler,
  REGISTER_MAX,
  registerOf,
  verifyFlag,
} from './builtins-circuits';
import { policyUntrusted } from './tool-policy';
import { readSheet } from './circuit-trace/read';

const dwgRow = (id: string, title: string) => ({
  id,
  title,
  data: {
    description: 'AutoCAD DWG model-space registry. ... within 2 drawing units of it ...',
    sourceFileId: `file-${id}`,
  },
});

describe('circuit_trace reads only what the caller may read', () => {
  beforeEach(() => {
    surfaces.readable = new Set();
    surfaces.opened = [];
    sqlCalls.files = [];
  });

  it('a table the caller cannot open is never queried', async () => {
    const r = await readSheet(
      'owner',
      { id: 'secret', title: 'PID-9', description: null, sourceFileId: null },
      '10000-001-01',
    );
    expect(r).toEqual({ kind: 'skip' });
    expect(sqlCalls.files).toEqual([]);
  });

  it('the trace holds the readable sheet and nothing of the other', async () => {
    listed.rows = [dwgRow('open', 'PID-1001'), dwgRow('secret', 'PID-SECRET')];
    surfaces.readable = new Set(['open']);
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(r.ok).toBe(true);
    const out = JSON.stringify((r as { output: unknown }).output);
    expect(out).toContain('PID-1001');
    expect(out).not.toContain('PID-SECRET');
    expect(out).not.toContain('secret');
    expect(sqlCalls.files.every((f) => f === '/tables/open.sqlite')).toBe(true);
    expect(surfaces.opened).toEqual(['open', 'secret']);
  });

  it('a table the scoped list does not return is never opened', async () => {
    listed.rows = [dwgRow('open', 'PID-1001')];
    surfaces.readable = new Set(['open', 'unlisted']);
    await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(surfaces.opened).toEqual(['open']);
  });

  it('pid_check lays the drawing out: a page whose layout fails is an error with its path', async () => {
    listed.rows = [dwgRow('open', 'PID-1001')];
    surfaces.readable = new Set(['open']);
    type Check = { ok: boolean; errors?: string[] };
    const check = async () =>
      (
        (await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner')) as {
          output: { pid_check: Check };
        }
      ).output.pid_check;
    expect(await check()).toMatchObject({ ok: true });
    layout.fail = true;
    try {
      const failed = await check();
      expect(failed.ok).toBe(false);
      expect(failed.errors).toEqual([
        expect.stringMatching(
          /^pages\[0\]\.data: page 'p1' passes the data check but its layout failed \(made to fail\)/,
        ),
      ]);
    } finally {
      layout.fail = false;
    }
  });

  it('a table that cannot be opened is skipped and named in limits, not the end of the trace', async () => {
    listed.rows = [dwgRow('broken', 'PID-LOST'), dwgRow('open', 'PID-1001')];
    surfaces.readable = new Set(['open', 'broken']);
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(r.ok).toBe(true);
    const out = (r as { output: { limits: string[]; sheets: { title: string }[] } }).output;
    expect(out.sheets.map((x) => x.title)).toEqual(['PID-1001']);
    expect(out.limits.some((l) => /PID-LOST: its table could not be opened/.test(l))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SQLITE_CANTOPEN');
  });

  it('its results are fenced as data: drawing text is the uploader’s (security LOW-5)', () => {
    const def = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_trace')!;
    expect(policyUntrusted(def.policy)).toBe(true);
    // The rights are unchanged: a read in the caller's own scope.
    expect(def.policy).toMatchObject({ effect: 'read', scope: 'any', keyArea: 'tables' });
  });

  it('asks for the circuit name when it is missing', async () => {
    const r = await circuitTraceHandler({}, 'owner');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/circuit is required/);
  });
});

describe('the register input is capped and cleaned', () => {
  it('lines and sheets past the caps are cut and said; text is cleaned and cut', () => {
    const NUL = String.fromCharCode(0);
    const { register, cut } = registerOf({
      source: `site${NUL} register ${'s'.repeat(300)}`,
      from: `E-101${NUL}`,
      lines: Array.from({ length: REGISTER_MAX.lines + 5 }, (_, i) => ({ number: `N${i}` })),
      sheets: Array.from({ length: REGISTER_MAX.sheets + 1 }, (_, i) => `S-${i}`),
    });
    expect(register!.lines).toHaveLength(REGISTER_MAX.lines);
    expect(register!.sheets).toHaveLength(REGISTER_MAX.sheets);
    expect(register!.from).toBe('E-101');
    expect(register!.source!.startsWith('site  register')).toBe(true);
    expect(register!.source!.length).toBeLessThanOrEqual(REGISTER_MAX.text);
    expect(cut.join(' ')).toMatch(/the register gave 2005 lines; the first 2000 were compared/);
    expect(cut.join(' ')).toMatch(/the register gave 201 sheets; the first 200 were compared/);
  });

  it('the schema holds the same caps', () => {
    const schema = CIRCUIT_TOOLS[0]!.inputSchema as {
      properties: {
        register: { properties: Record<string, { maxItems?: number; maxLength?: number }> };
      };
    };
    const reg = schema.properties.register.properties;
    expect(reg.lines!.maxItems).toBe(REGISTER_MAX.lines);
    expect(reg.sheets!.maxItems).toBe(REGISTER_MAX.sheets);
    expect(reg.source!.maxLength).toBe(REGISTER_MAX.text);
  });
});

describe('a drawing replaced after its table was built (circuit_trace)', () => {
  beforeEach(() => {
    surfaces.readable = new Set(['open']);
    surfaces.opened = [];
    sqlCalls.files = [];
  });

  it('says the sheet geometry is the older revision and how to rebuild it', async () => {
    listed.rows = [
      {
        ...dwgRow('open', 'PID-1001'),
        data: { ...dwgRow('open', 'PID-1001').data, sourceSha256: 'a'.repeat(64) },
        fileSha: 'b'.repeat(64),
      },
    ];
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    const limits = (r as { output: { limits: string[] } }).output.limits.join(' ');
    expect(limits).toMatch(/PID-1001: its drawing file was replaced after its table was built/);
    expect(limits).toMatch(/dwg-reindex --file=file-open --again --apply/);
  });

  it('a table that still matches its file says nothing', async () => {
    listed.rows = [
      {
        ...dwgRow('open', 'PID-1001'),
        data: { ...dwgRow('open', 'PID-1001').data, sourceSha256: 'a'.repeat(64) },
        fileSha: 'a'.repeat(64),
      },
    ];
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect((r as { output: { limits: string[] } }).output.limits.join(' ')).not.toMatch(
      /replaced/,
    );
  });
});

describe('circuit_verify input (LOW-9)', () => {
  it('kinds that name no kind are refused, naming the valid ones', async () => {
    const r = await circuitVerifyHandler({ circuit: 'X-1', kinds: ['pipes', 'valves'] }, 'o');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(
      /kinds named no kind of guess \(got 'pipes', 'valves'\): use any of 'join', 'end', 'link', 'valve'/,
    );
  });

  it('max_questions below 1 is refused with what to send instead', async () => {
    for (const m of [0, -3, 'none']) {
      const r = await circuitVerifyHandler({ circuit: 'X-1', max_questions: m }, 'o');
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/max_questions must be a whole number from 1/);
    }
  });

  it('dry_run and recheck take true or the word', () => {
    expect(verifyFlag(true)).toBe(true);
    expect(verifyFlag('true')).toBe(true);
    expect(verifyFlag(' TRUE ')).toBe(true);
    expect(verifyFlag('false')).toBe(false);
    expect(verifyFlag(1)).toBe(false);
    expect(verifyFlag(undefined)).toBe(false);
  });

  it('the schema holds max_questions to at least 1', () => {
    const def = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_verify')!;
    const props = (def.inputSchema as { properties: Record<string, { minimum?: number }> })
      .properties;
    expect(props.max_questions!.minimum).toBe(1);
    expect(props.recheck).toBeDefined();
  });
});
