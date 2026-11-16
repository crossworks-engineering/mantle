/**
 * The trace of the picture pass (images.ts, maybeExtractEmbeddedImages). The
 * pass runs in the admission (gates.ts), before the extract is admitted and
 * before its `extractor_run` trace opens. With no trace open it opens one of
 * its own for its step, of the kind `pipeline_run` with `source: 'upload'`,
 * as the upload's database read does (auto-table.ts): never `extractor_run`,
 * so the sweep's missed-extract clause (`noExtractSinceWriteSql`) does not
 * take a file whose extract has not run for one that has. Against a real,
 * migrated Postgres; the byte load gives nothing, so the pass records why in
 * its step and stops (no parser, no model).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/images-trace.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('./file-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bytes')>();
  return { ...actual, loadFileBytes: async () => null };
});

describe.skipIf(!URL)('the trace of the picture pass before the extract', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  let owner = '';

  const file = async (name: string) => {
    const id = randomUUID();
    await su`insert into nodes (id, owner_id, type, title, path, data)
      values (${id}, ${owner}, 'file', ${name}, 'files',
              ${JSON.stringify({ filename: name, sha256: 'a'.repeat(64) })}::jsonb)`;
    const { eq } = await import('drizzle-orm');
    const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
    return row!;
  };
  type TraceRow = { id: string; kind: string; status: string; data: Record<string, unknown> };
  type StepRow = { name: string; status: string; trace: string; meta: Record<string, unknown> };
  /** The traces and steps of a file, once each has closed. */
  const tracesOf = async (id: string) => {
    let traces: TraceRow[] = [];
    let steps: StepRow[] = [];
    await vi.waitFor(async () => {
      traces = await su<TraceRow[]>`
        select id::text as id, kind::text as kind, status::text as status, data
          from traces where subject_id = ${id} order by started_at`;
      steps = await su<StepRow[]>`
        select s.name, s.status::text as status, s.trace_id::text as trace, s.meta
          from trace_steps s join traces t on t.id = s.trace_id
         where t.subject_id = ${id} order by s.started_at`;
      expect(traces.length).toBeGreaterThan(0);
      expect(steps.length).toBeGreaterThan(0);
      expect([...traces, ...steps].every((r) => r.status !== 'running')).toBe(true);
    });
    return { traces, steps };
  };
  /** The sweep's own clause (runtime.ts): true while no extract has run for
   *  the file since its last write, so the sweep still queues it. */
  const sweepPicks = async (id: string) => {
    const { and, eq } = await import('drizzle-orm');
    const rows = await m.db
      .select({ id: m.nodes.id })
      .from(m.nodes)
      .where(and(eq(m.nodes.id, id), m.noExtractSinceWriteSql()));
    return rows.length === 1;
  };

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    owner = await ts.ensureTestAnchor(su);
    m = await import('@mantle/db');
    ({ maybeExtractEmbeddedImages } = await import('./images'));
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('opens no extractor_run: its step is in a pipeline_run of the upload, and the sweep still queues the file', async () => {
    const node = await file('manual.docx');
    await maybeExtractEmbeddedImages(node, owner, 10);
    const { traces, steps } = await tracesOf(node.id);
    // ONE trace, of the kind the upload's database read has; ids and fixed
    // words only, no file name.
    expect(traces.map(({ kind, data }) => ({ kind, data }))).toEqual([
      {
        kind: 'pipeline_run',
        data: { fileId: node.id, source: 'upload', pass: 'embedded_images' },
      },
    ]);
    expect(steps.map((s) => [s.name, s.trace])).toEqual([['extract_images', traces[0]!.id]]);
    expect(steps[0]!.meta).toMatchObject({ bytes_available: false });
    // An extract job that dies after this pass is queued again by the sweep.
    expect(await sweepPicks(node.id)).toBe(true);
  });
});
