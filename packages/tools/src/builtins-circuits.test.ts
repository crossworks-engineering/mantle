/**
 * circuit_trace's rights, without a database: the drawings come from the
 * caller's scoped list of file rows, a refused file is left out and said, each
 * reads its database or else its old Table, and one that gives no sheet is named.
 * The same on a real Postgres with row level security:
 * builtins-circuits.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TABS = vi.hoisted(() => ['Layers', 'Segments', 'Nodes', 'Circuits']);
const listed = vi.hoisted(() => ({
  rows: [] as { id: string; title: string; path: string; data: unknown }[],
  tables: [] as Record<string, unknown>[],
}));
const surfaces = vi.hoisted(() => ({
  /** Files with a `.sqlite`. */
  databases: new Set<string>(),
  /** Old Tables the caller opens. */
  readable: new Set<string>(),
  opened: [] as string[],
}));
const refused = vi.hoisted(() => ({ ids: new Map<string, string>() }));
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
    selectDistinct: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => listed.rows,
    // The list of old Tables ends at its order.
    then: (done: (rows: unknown[]) => void) => done(listed.tables),
  };
  return {
    db: chain,
    nodes: {
      id: 'id',
      title: 'title',
      path: 'path',
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
      tabs: TABS.map((name) => ({ name, viewName: name })),
    };
  },
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/files')>()),
  extractorRefusesFile: () => false,
  fileDataListKeys: () => 'data',
  fileDataRefusals: async () =>
    new Map([...refused.ids].map(([id, message]) => [id, { code: 'private', message }])),
  fileDbSqlitePath: async (id: string) => {
    if (!surfaces.databases.has(id)) return null;
    surfaces.opened.push(id);
    return `/files/.file-dbs/${id}.sqlite`;
  },
  filesRootMounted: async () => true,
  readFileDbNone: async (id: string) => (id.includes('none') ? 'no-rows' : null),
}));
vi.mock('@mantle/tabledb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tabledb')>()),
  describeWorkbook: () => TABS.map((name) => ({ name, viewName: name })),
  runTableSql: async (file: string, q: string) => {
    sqlCalls.files.push(file);
    if (q.includes('_meta')) {
      return {
        columns: ['v'],
        rows: [['AutoCAD DWG model-space registry. ... within 2 drawing units of it ...']],
        truncated: false,
      };
    }
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

const SHA = 'a'.repeat(64);
const dwgRow = (id: string, title: string) => ({
  id,
  title: `${title}.dwg`,
  path: 'files',
  data: { filename: `${title}.dwg`, sha256: SHA },
});
const oldTable = (fileId: string, stamped: string | null = SHA) => ({
  id: `table-${fileId}`,
  fileId,
  description: 'AutoCAD DWG model-space registry. ... within 2 drawing units of it ...',
  stamped,
});
const trace = async () => {
  const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
  expect(r.ok).toBe(true);
  return (
    r as {
      output: {
        limits: string[];
        pid: { trace?: { tables: string[] } };
        pid_check: { ok: boolean; errors?: string[] };
        sheets: { title: string; tableId: string; url?: string }[];
      };
    }
  ).output;
};

describe('circuit_trace reads only what the caller may read', () => {
  beforeEach(() => {
    listed.rows = [];
    listed.tables = [];
    refused.ids = new Map();
    surfaces.databases = new Set();
    surfaces.readable = new Set();
    surfaces.opened = [];
    sqlCalls.files = [];
  });

  it('an old Table the caller cannot open is never queried', async () => {
    const r = await readSheet(
      'owner',
      {
        id: 'file-1',
        title: 'PID-9',
        description: null,
        sourceFileId: 'file-1',
        oldTableId: 'secret',
      },
      '10000-001-01',
    );
    expect(r).toEqual({ kind: 'skip' });
    expect(sqlCalls.files).toEqual([]);
  });

  it('a file with a database reads it; any other reads its old Table; each file is one sheet', async () => {
    listed.rows = [dwgRow('with-db', 'PID-1001'), dwgRow('with-old', 'PID-1002')];
    // A file with both reads only its database: no drawing is traced twice.
    listed.tables = [oldTable('with-old')];
    surfaces.databases = new Set(['with-db']);
    surfaces.readable = new Set(['table-with-old']);
    const out = await trace();
    // The sheet is the file: its title without the extension, its own id, its link.
    expect(out.sheets.map((x) => [x.title, x.tableId, x.url])).toEqual([
      ['PID-1001', 'with-db', 'https://brain.test/n/with-db'],
      ['PID-1002', 'with-old', 'https://brain.test/n/with-old'],
    ]);
    expect([...new Set(sqlCalls.files)].sort()).toEqual([
      '/files/.file-dbs/with-db.sqlite',
      '/tables/table-with-old.sqlite',
    ]);
    // A new trace names file ids in the same field.
    expect(out.pid.trace?.tables).toEqual(['with-db', 'with-old']);
  });

  it('a file the scoped list does not return is never opened', async () => {
    listed.rows = [dwgRow('open', 'PID-1001')];
    surfaces.databases = new Set(['open', 'unlisted']);
    await trace();
    expect(surfaces.opened).toEqual(['open', 'open']);
  });

  it('a refused file is left out and said so, even with an old Table', async () => {
    listed.rows = [dwgRow('open', 'PID-1001'), dwgRow('refused', 'PID-PRIVATE')];
    listed.tables = [oldTable('refused')];
    surfaces.databases = new Set(['open', 'refused']);
    surfaces.readable = new Set(['table-refused']);
    refused.ids = new Map([['refused', 'This file is set to stay out of the brain.']]);
    const out = await trace();
    expect(out.sheets.map((x) => x.title)).toEqual(['PID-1001']);
    expect(surfaces.opened).not.toContain('refused');
    expect(surfaces.opened).not.toContain('table-refused');
    expect(out.limits.join(' ')).toMatch(
      /PID-PRIVATE: left out of this trace\. This file is set to stay out of the brain\./,
    );
  });

  it("a drawing with no sheet gets E's reason; past 10, a count, so a trace never looks complete", async () => {
    listed.rows = [
      dwgRow('open', 'PID-1001'),
      dwgRow('none', 'PID-NONE'),
      dwgRow('building', 'PID-NEW'),
    ];
    surfaces.databases = new Set(['open']);
    const said = (await trace()).limits.join(' ');
    expect(said).toMatch(/PID-NONE: gives no sheet.*This drawing gave no rows/);
    expect(said).toMatch(/PID-NEW: gives no sheet.*No database yet\. If it was just uploaded/);

    listed.rows = [
      dwgRow('open', 'PID-1001'),
      ...Array.from({ length: 13 }, (_, i) => dwgRow(`gap-${i}`, `PID-GAP-${i}`)),
    ];
    const { limits } = await trace();
    expect(limits.filter((l) => /^PID-GAP-\d+: gives no sheet/.test(l))).toHaveLength(10);
    expect(limits).toContain(
      '3 more drawings gave no sheet, so if one carries this circuit the trace is missing it.',
    );
  });

  it('pid_check lays the drawing out: a page whose layout fails is an error with its path', async () => {
    listed.rows = [dwgRow('open', 'PID-1001')];
    surfaces.databases = new Set(['open']);
    expect((await trace()).pid_check).toMatchObject({ ok: true });
    layout.fail = true;
    try {
      const failed = (await trace()).pid_check;
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

  it('a drawing that cannot be opened is skipped and named in limits, not the end of the trace', async () => {
    listed.rows = [dwgRow('broken', 'PID-LOST'), dwgRow('open', 'PID-1001')];
    surfaces.databases = new Set(['open', 'broken']);
    const out = await trace();
    expect(out.sheets.map((x) => x.title)).toEqual(['PID-1001']);
    expect(out.limits.some((l) => /PID-LOST: its rows could not be opened/.test(l))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SQLITE_CANTOPEN');
  });

  it('its results are fenced as data: drawing text is the uploader\u2019s (security LOW-5)', () => {
    const def = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_trace')!;
    expect(policyUntrusted(def.policy)).toBe(true);
    // The rights are unchanged: a read in the caller's own scope.
    expect(def.policy).toMatchObject({ effect: 'read', scope: 'any', keyArea: 'files' });
  });

  it('asks for the circuit name when it is missing', async () => {
    const r = await circuitTraceHandler({}, 'owner');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/circuit is required/);
  });

  it('a file replaced after its old Table was built: says so, and how to rebuild it', async () => {
    listed.rows = [dwgRow('file-open', 'PID-1001')];
    surfaces.readable = new Set(['table-file-open']);
    listed.tables = [oldTable('file-open', 'b'.repeat(64))];
    const limits = (await trace()).limits.join(' ');
    expect(limits).toMatch(/PID-1001: its drawing file was replaced after its table was built/);
    expect(limits).toMatch(/dwg-reindex --file=file-open --again --apply/);
    // Still on its bytes: nothing to say.
    listed.tables = [oldTable('file-open')];
    expect((await trace()).limits.join(' ')).not.toMatch(/replaced/);
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
