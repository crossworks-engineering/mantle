/**
 * The two templates of an own Reader (docs/pipeline-template/, made up):
 *
 *  - the types the Bun template carries (mantle-pipeline.d.ts) fit the
 *    contract (./contract.ts): the core can call its step, and what the
 *    step gives is a result and a write input of the contract. A drift is
 *    a typecheck failure here;
 *  - each template folder, sent as a package, passes the one check of a
 *    package (checkPackage);
 *  - the Bun step reads the sample in this process, and its result passes
 *    the one result check (checkStepResult). The Python step runs through
 *    a real parser job (server/parser/src/pipeline-job.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as T from '../../../../docs/pipeline-template/bun/mantle-pipeline';
import type { FileTabsWriteInput, PipelineStep, PipelineStepResult } from './contract';
import { checkPackage } from './package-check';
import { checkStepResult } from './step-check';
import { inProcessStepJob } from './test-job';

const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/pipeline-template',
);

/** A folder as an install sends it: text files as text, others as base64. */
function packageOfFolder(dir: string): { files: Record<string, string | { base64: string }> } {
  const files: Record<string, string | { base64: string }> = {};
  const walk = (sub: string) => {
    for (const name of readdirSync(path.join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else files[rel] = readFileSync(path.join(dir, rel), 'utf8');
    }
  };
  walk('');
  return { files };
}

describe('the templates of an own Reader', () => {
  it('the types of the Bun template fit the contract', () => {
    expectTypeOf<T.PipelineStep>().toMatchTypeOf<PipelineStep>();
    expectTypeOf<T.PipelineStepResult>().toMatchTypeOf<PipelineStepResult>();
    expectTypeOf<T.FileTabsWriteInput>().toMatchTypeOf<FileTabsWriteInput>();
  });

  it('each template folder is a package that passes the one check', () => {
    for (const lang of ['bun', 'python']) {
      const out = checkPackage(packageOfFolder(path.join(TEMPLATES, lang)));
      expect(out.ok ? out.manifest.runtime : out.error, lang).toBe(lang);
    }
  });

  it('the Bun step reads the sample into its two tabs, and its result passes the check', async () => {
    const { step } = (await import(path.join(TEMPLATES, 'bun', 'step.ts'))) as {
      step: PipelineStep;
    };
    const bytes = readFileSync(path.join(TEMPLATES, 'sample.lx9'));
    const result = await step(
      { api: 1, step: 1, options: { max_rows: 200000 } },
      inProcessStepJob(bytes, os.tmpdir()),
    );
    const checked = checkStepResult(JSON.parse(JSON.stringify(result)));
    expect(checked.ok).toBe(true);
    const input = (result.calls?.[0] as { input: FileTabsWriteInput }).input;
    expect(input.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
    expect(input.tabs[0]!.rows[0]).toEqual(['2026-01-04T08:00:00', 'PT-101', 412.5, 'kPa']);
    const other = await step(
      { api: 1, step: 1, options: {} },
      inProcessStepJob(Buffer.from('not lx9'), os.tmpdir()),
    );
    expect(other.status).toBe('not_mine');
  });
});
