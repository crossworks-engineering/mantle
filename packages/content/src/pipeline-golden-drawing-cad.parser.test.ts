/**
 * The end-to-end compare of the move of `drawing-cad`: the golden files of
 * the old path (./pipeline-golden-drawing-cad.test.ts has the in-process
 * compare and its notes), now through a REAL parser (server/parser main.ts
 * on a loopback port) with the CAD tier: the step runs in a `pipelineRun`
 * job and starts the Python child through `job.cadRender`. The tabs, the
 * text, the picture (its bytes for the made-up fixtures; the sample DWG
 * renders to other PNG bytes on every run, so for it the picture's form, as
 * the mask in ./pipeline-golden.ts says), the readings and the Table, and
 * one heavy job for a drawing's three passes and its readings.
 *
 * It needs the CAD tier: it runs where PARSER_PYTHON names it and must run
 * where PARSER_TESTS_REQUIRE_CAD is 1. Today that is the workstation only:
 * the parser image built from the branch, with this file mounted. CI does
 * not run it (the image holds no test files), and the lanes skip it (no
 * PARSER_PYTHON). Elsewhere it is skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetParserFailures } from '@mantle/files';
import { CAD_GOLDEN as G, cadGoldenPasses } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '..', '..', '..', 'server', 'parser', 'src', 'main.ts');
const TIER = process.env.PARSER_PYTHON;
const REQUIRE = process.env.PARSER_TESTS_REQUIRE_CAD === '1';

describe.skipIf(!REQUIRE && !(TIER && existsSync(TIER)))(
  'drawing-cad through a real parser job (the CAD tier)',
  () => {
    let child: ChildProcess;
    let work: string;
    let jobs = 0;
    beforeAll(async () => {
      work = mkdtempSync(path.join(os.tmpdir(), 'drawing-cad-parser-'));
      const port = await new Promise<number>((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      child = spawn(process.execPath, ['--no-env-file', MAIN], {
        cwd: path.dirname(path.dirname(MAIN)),
        env: {
          ...process.env,
          PARSER_PORT: String(port),
          PARSER_HOST: '127.0.0.1',
          PARSER_TOKEN: 't',
          PARSER_WORKDIR: path.join(work, 'jobs'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      await new Promise<void>((resolve, reject) => {
        const on = (d: Buffer) => {
          out += d.toString();
          if (out.includes('listening on')) resolve();
        };
        child.stdout!.on('data', on);
        child.stderr!.on('data', on);
        child.once('exit', (code) => reject(new Error(`the parser exited ${code}: ${out}`)));
      });
      vi.stubEnv('PARSER_URL', `http://127.0.0.1:${port}`);
      vi.stubEnv('PARSER_TOKEN', 't');
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/pipeline/run')) jobs += 1;
        return real(url, init);
      });
    }, 60_000);
    afterAll(() => {
      child?.kill('SIGKILL');
      rmSync(work, { recursive: true, force: true });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    afterEach(() => resetParserFailures());

    for (const name of G.names) {
      it(`${name}: the golden files, by ${G.jobsOf(name)} job(s)`, async () => {
        jobs = 0;
        const got = await cadGoldenPasses(G.bytesOf(name), G.extOf(name), () => jobs);
        expect(got.parsed, 'the tabs').toEqual(G.golden(`${name}.json`));
        expect(got.text, 'the text').toEqual(G.golden(`${name}.text.json`));
        expect(G.pictureOf(name, got.pictures), 'the picture').toEqual(
          G.pictureOf(name, G.golden(`${name}.pictures.json`)),
        );
        expect(got.readings, 'the readings').toEqual(G.golden(`${name}.readings.json`));
        expect(got.table, 'the Table workbook').toEqual(G.golden(`${name}.table.json`));
        expect(got.jobs).toBe(G.jobsOf(name));
      }, 240_000);
    }
  },
);
