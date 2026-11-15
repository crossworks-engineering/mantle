/**
 * The golden compare of the move of `drawing-cad` (docs/pipelines.md, "The
 * same-result proof of a move"). The golden files in
 * packages/files/src/pipelines/pkg/drawing-cad/golden/ were written by the
 * OLD path (the adapter in file-database.ts, the text digest and the picture
 * of the brain's dwg.ts, all on one parser exchange `dwgRender`) in the
 * parser image, before the move, in their own commit. With them, the CAD
 * tier's raw reply to each fixture (fixtures/replies/).
 *
 * Here the brain's passes run as an extract runs them: the database
 * (parseFileSheets), the text (parseDocumentBytes), the picture
 * (extractEmbeddedImages), the readings of dwg-reindex and the Table
 * workbook. The parser's `pipelineRun` job runs the real step in this
 * process, with a `cadRender` that answers the recorded reply. Each must
 * give the golden text. A golden file is never changed to make this pass.
 *
 * One heavy job for three passes: a drawing's database, text, picture and
 * readings cost ONE `pipelineRun` job, as they cost one `dwgRender` before.
 * A file that is not its extension's format costs none. The Table workbook
 * of dwg-reindex --table is its own run (no symbols); that mode builds only
 * the Table, so it is still one job a file there.
 *
 * No stored shape changed, and no word: the same ParsedFile for every
 * fixture. The damaged DWG failed the old exchange and fails the new job;
 * outside an extract's scope each pass asks again, as before (six jobs).
 *
 * The end-to-end compare through a REAL parser job (the CAD tier in the
 * parser image, `job.cadRender`) is ./pipeline-golden-drawing-cad.parser.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readerFor, BUILTIN_PIPELINES, pipelineStampOf, resetParserFailures } from '@mantle/files';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';
import { parseFileSheets } from './file-database';
import { CAD_GOLDEN as G, cadGoldenPasses } from './pipeline-golden';
import { pipelinesOf } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = pipelinesOf([]);

const CAD = readerFor(BUILTIN_PIPELINES, 'dwg')!;

describe('drawing-cad: the step gives what the old path gave', () => {
  let reply: Record<string, unknown> = {};
  let jobs = 0;
  beforeAll(() => {
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    const answer = inProcessPipelineFetch(undefined, {
      // The CAD tier's recorded reply; a failed one is the job's failure.
      cadRender: async () => {
        if (reply.ok !== true) {
          const error = (reply.error ?? {}) as { code?: string; message?: string };
          throw Object.assign(new Error(error.message ?? 'the CAD tier failed'), {
            code: error.code ?? 'failed',
          });
        }
        return reply;
      },
    });
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/pipeline/run')) jobs += 1;
      return answer(url, init);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterEach(() => resetParserFailures());

  it('the fixed set is the fourteen made-up files and the two test drawings', () => {
    expect(G.names).toEqual([
      'blocks.dxf',
      'circuits.dxf',
      'constructed_tags.dgn',
      'damaged.dwg',
      'dashes.dxf',
      'empty.dxf',
      'line-work.dxf',
      'mini-pfd.dxf',
      'mini-pid.dxf',
      'mtexts.dxf',
      'no-texts.dxf',
      'not-cad.dwg',
      'not-cad.dxf',
      'odd-values.dxf',
      'office.dgn',
      'sample_AC1032.dwg',
    ]);
    expect(CAD).toMatchObject({ id: 'drawing-cad', runtime: 'bun', entry: 'step.ts' });
    expect(CAD.needs).toEqual({ weight: 'heavy', timeMs: 240_000 });
  });

  for (const name of G.names) {
    it(`${name}: the same tabs, text, picture, readings and Table, by ${G.jobsOf(name)} job(s)`, async () => {
      reply = G.replyOf(name);
      jobs = 0;
      const got = await cadGoldenPasses(G.bytesOf(name), G.extOf(name), () => jobs, pipelines);
      expect(got.parsed, 'the tabs').toEqual(G.golden(`${name}.json`));
      expect(got.text, 'the text').toEqual(G.golden(`${name}.text.json`));
      expect(G.pictureOf(name, got.pictures), 'the picture').toEqual(
        G.pictureOf(name, G.golden(`${name}.pictures.json`)),
      );
      expect(got.readings, 'the readings').toEqual(G.golden(`${name}.readings.json`));
      expect(got.table, 'the Table workbook').toEqual(G.golden(`${name}.table.json`));
      expect(got.jobs).toBe(G.jobsOf(name));
      // The picture is the very bytes the CAD tier sent: the step passes
      // them on as they came.
      const png = typeof reply.png_base64 === 'string' ? reply.png_base64 : '';
      expect(got.pictures).toEqual({
        pictures: png
          ? [
              expect.objectContaining({
                sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
              }),
            ]
          : [],
      });
    });
  }

  it('the stamp is the same: the id, the version and the shapes did not move', async () => {
    reply = G.replyOf('circuits.dxf');
    const parsed = await parseFileSheets(G.bytesOf('circuits.dxf'), 'dxf', { pipelines });
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    expect(
      pipelineStampOf(
        CAD,
        parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
      ),
    ).toMatchObject({ pipeline_id: 'drawing-cad', pipeline_version: '1.0.0', pipeline_api: '1' });
  });
});
