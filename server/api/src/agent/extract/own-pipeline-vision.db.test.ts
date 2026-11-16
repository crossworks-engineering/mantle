/**
 * The vision asks of an own Reader (docs/pipelines.md, "Vision asks of an
 * own Reader"), on a real migrated Postgres and a real files root. The own
 * row is the Bun template's package (made up), its manifest changed; the
 * parser is faked at the fetch, and the fetch runs the step below in this
 * process. The vision worker is a fake (runVisionWorker), and so is the
 * guard of model work (llmWorkAllowed), so a test can turn it off.
 *
 *  - An upload: step 1 writes a picture and asks the vision worker once;
 *    the worker gets the picture's bytes and the question; step 2 gets the
 *    answer and writes it as tabs and text. One ask, one vision call.
 *  - The asks are capped by `needs.workers.vision`.
 *  - A file that may get no model work: the ask is refused, no vision call,
 *    and step 2 still writes.
 *  - A read with no ask (a run on demand, a re-read, a test) is
 *    model-free: the ask is refused, no vision call.
 *  - An image type (`.tif`) whose own Reader takes the file: the Reader's
 *    text is the file's text, and the raw image is not sent to vision. A
 *    Reader that says `not_mine` leaves the file to vision, as before.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/own-pipeline-vision.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import type { PipelineStep, PipelineStepRequest } from '@mantle/files';

const h = vi.hoisted(() => ({
  allowed: true,
  vision: [] as { mimeType: string; prompt?: string; bytes: string }[],
}));
vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  llmWorkAllowed: async () => h.allowed,
}));
vi.mock('@mantle/runtime/agent', async (orig) => ({
  ...(await orig<typeof import('@mantle/runtime/agent')>()),
  runVisionWorker: async (o: { bytes: Buffer; mimeType: string; prompt?: string }) => {
    h.vision.push({ mimeType: o.mimeType, prompt: o.prompt, bytes: o.bytes.toString('latin1') });
    return {
      ran: true,
      text: `LINE NO: 1234-56 (asked: ${o.prompt ?? 'describe'})`,
      note: null,
      model: 'fake',
    };
  },
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/pipeline-template',
);
/** The Bun template as an install sends it, with manifest changes. */
const pkg = (change: Record<string, unknown>) => {
  const out: Record<string, string> = {};
  for (const n of readdirSync(path.join(TEMPLATES, 'bun'))) {
    out[n] = readFileSync(path.join(TEMPLATES, 'bun', n), 'utf8');
  }
  out['pipeline.json'] = JSON.stringify({ ...JSON.parse(out['pipeline.json']!), ...change });
  return { files: out };
};
/** The first bytes of a PNG, then a mark: enough for the type check. */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('picture')]);

/** The step the fake parser runs: step 1 asks about `asks` pictures (none
 *  for a body that says `not mine`), step 2 writes what it got. */
const visionStep = async (req: PipelineStepRequest, body: Buffer) => {
  if (body.toString('utf8').includes('not mine')) return { result: { status: 'not_mine' } };
  if (req.step === 1) {
    const n = Number(req.options.asks ?? 1);
    return {
      result: {
        status: 'ok',
        calls: Array.from({ length: n }, (_, i) => ({
          call: 'worker',
          worker: 'vision',
          input: { picture: `p${i}.png`, question: `Read the title block of p${i}.` },
        })),
        state: { asks: req.asks === true },
      },
      pictures: Array.from({ length: n }, (_, i) => ({
        file: `p${i}.png`,
        bytes_base64: PNG.toString('base64'),
      })),
    };
  }
  const answers = (req.answers ?? []).map((a) =>
    a.ok ? String((a.output as { text: string }).text) : a.error,
  );
  return {
    result: {
      status: 'ok',
      calls: [
        {
          call: 'tool',
          tool: 'file_tabs_write',
          input: {
            tabs: [
              {
                name: 'Answers',
                columns: [{ name: 'Answer', type: 'text' }],
                rows: answers.map((a) => [a]),
              },
            ],
            text: `Reader text. ${answers.join(' | ')}`,
          },
        },
      ],
    },
  };
};

describe.skipIf(!URL)('the vision asks of an own Reader', () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let loadExtractableBody: typeof import('./load-body').loadExtractableBody;
  let state: typeof import('@mantle/content/pipeline-state');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.vision';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-own-vision-'));
  const jobs: string[] = [];

  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const upload = async (name: string, bytes: Buffer) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({ ownerId: anchor, parentPath: FOLDER, filename: name, bytes, overwrite: true }),
    );
  const nodeRow = async (id: string) => {
    const { eq } = await import('drizzle-orm');
    const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
    return row!;
  };
  const body = async (id: string) => {
    const node = await nodeRow(id);
    return loadExtractableBody(
      node,
      anchor,
      { slug: 'test-extractor' } as never,
      (node.data ?? {}) as Record<string, unknown>,
    );
  };
  /** The database pass, then the text pass (gates.ts). */
  const extract = async (id: string) => {
    await maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
    return body(id);
  };
  const answers = async (id: string) => {
    const sha = ((await nodeRow(id)).data as { sha256: string }).sha256;
    const db = await f.fileDbSqlitePath(id, sha);
    if (!db) return null;
    const { scanTabColumns } = await import('@mantle/tabledb');
    const out: unknown[] = [];
    scanTabColumns(db, 'Answers', ['Answer'], { maxRows: 100, cellMaxChars: 4000 }, (row) => {
      out.push(row.Answer);
      return true;
    });
    return out;
  };
  const install = (id: string, change: Record<string, unknown>) =>
    state.underPackageLock(anchor, id, (row) => row.put(null, pkg({ id, ...change })));
  const remove = (id: string) => state.underPackageLock(anchor, id, (row) => row.remove());
  const unique = (s = '') => Buffer.from(`${s} ${randomUUID()}`);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    state = await import('@mantle/content/pipeline-state');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
    ({ loadExtractableBody } = await import('./load-body'));
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof m.ensureViewerRoles>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: FOLDER }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${FOLDER}, ${FOLDER}::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jobs.length = 0;
    h.vision.length = 0;
    h.allowed = true;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        const n = Number(new Headers(init?.headers).get('x-parser-opts-length') ?? 0);
        const opts = JSON.parse(all.subarray(0, n).toString('utf8')) as {
          id: string;
          request: Parameters<PipelineStep>[0];
        };
        jobs.push(`${opts.id}#${opts.request.step}`);
        const { result, pictures = [] } = (await visionStep(opts.request, all.subarray(n))) as {
          result: unknown;
          pictures?: unknown[];
        };
        return Response.json({ ok: true, result, pictures });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('an upload: one ask, one vision call with the picture and the question, the answer in the tabs and the text', async () => {
    await install('vision-reader', {
      match: { ext: ['vis1'] },
      needs: { weight: 'light', workers: { vision: 2 } },
    });
    const file = await upload(`${randomUUID().slice(0, 8)}.vis1`, unique());
    const got = await extract(file.id);
    expect(jobs).toEqual(['vision-reader#1', 'vision-reader#2']);
    expect(h.vision).toEqual([
      {
        mimeType: 'image/png',
        prompt: 'Read the title block of p0.',
        bytes: PNG.toString('latin1'),
      },
    ]);
    expect(await answers(file.id)).toEqual([
      'LINE NO: 1234-56 (asked: Read the title block of p0.)',
    ]);
    expect(got.ok && got.rawBody).toMatch(/Reader text\. LINE NO: 1234-56/);
    await remove('vision-reader');
  });

  it('the asks are capped by needs.workers.vision', async () => {
    await install('vision-capped', {
      match: { ext: ['vis2'] },
      needs: { weight: 'light', workers: { vision: 1 } },
      options: { asks: { type: 'number', label: 'Asks', default: 3, min: 1, max: 8 } },
    });
    const file = await upload(`${randomUUID().slice(0, 8)}.vis2`, unique());
    await extract(file.id);
    expect(h.vision).toHaveLength(1);
    expect((await answers(file.id))?.slice(1)).toEqual(['refused', 'refused']);
    await remove('vision-capped');
  });

  it('no model work for the file: the ask is refused, no vision call, and the Reader still writes', async () => {
    await install('vision-guarded', {
      match: { ext: ['vis3'] },
      needs: { weight: 'light', workers: { vision: 1 } },
    });
    h.allowed = false;
    const file = await upload(`${randomUUID().slice(0, 8)}.vis3`, unique());
    await extract(file.id);
    expect(h.vision).toEqual([]);
    expect(await answers(file.id)).toEqual(['refused']);
    await remove('vision-guarded');
  });

  it('a read with no ask (a run on demand, a re-read, a test) is model-free: refused, no vision call', async () => {
    await install('vision-demand', {
      match: { ext: ['vis4'] },
      needs: { weight: 'light', workers: { vision: 1 } },
    });
    const { parseFileSheets } = await import('@mantle/content/file-database');
    const { boxPipelines } = await import('@mantle/content/pipeline-registry');
    const parsed = await parseFileSheets(unique(), 'vis4', {
      pipelines: await boxPipelines(anchor),
    });
    expect(h.vision).toEqual([]);
    expect(parsed.kind === 'sheets' && parsed.sheets[0]?.rows).toEqual([['refused']]);
    await remove('vision-demand');
  });

  it('a .tif its own Reader takes: the Reader gives the text, the raw image goes to no vision', async () => {
    await install('vision-tif', {
      match: { ext: ['tif'] },
      needs: { weight: 'light', workers: { vision: 1 } },
    });
    const taken = await upload(`${randomUUID().slice(0, 8)}.tif`, unique());
    const got = await extract(taken.id);
    // One vision call: the Reader's ask, on its picture. None on the raw TIFF.
    expect(h.vision.map((v) => v.mimeType)).toEqual(['image/png']);
    expect(got.ok && got.rawBody).toMatch(/Reader text\. LINE NO: 1234-56/);

    h.vision.length = 0;
    const left = await upload(`${randomUUID().slice(0, 8)}.tif`, unique('not mine'));
    await extract(left.id);
    // The Reader said not_mine: the raw image went to vision, as before.
    expect(h.vision.map((v) => v.mimeType)).toEqual(['image/tiff']);
    await remove('vision-tif');
  });
});
