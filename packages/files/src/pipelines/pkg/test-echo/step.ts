/**
 * A test-only package (docs/pipelines.md, "The runner"). It is not in the
 * package index of the image (../index.ts): the parser job finds it only when
 * PARSER_TEST_PIPELINES is 1, which the parser's own tests set. What it does
 * is named by the option `mode`:
 *
 *  - `write` (or none): one tab `Lines`, a row for each line of the body.
 *  - `ask`: step 1 asks the worker `decider` (or the option `worker`) once,
 *    with a state; step 2 writes the answer it got in the tab `Answer`.
 *  - `loop`: asks the worker `decider` on every step.
 *  - `not_mine`, `failed`: that status. `throw`: a throw.
 *  - `over`: more calls than a result may hold.
 *  - `slow`: waits past the manifest's time.
 *  - `after`: reads the rows of the tab `Texts` of an `after` body and
 *    writes them back in the tab `Echo`.
 *  - `picture`: writes a file in the job's folder and names it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FILE_TABS_WRITE,
  PIPELINE_CALLS_MAX,
  type FileTabsWriteInput,
  type PipelineStep,
  type PipelineStepResult,
} from '../../contract';

const write = (input: FileTabsWriteInput): PipelineStepResult => ({
  status: 'ok',
  calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input }],
});

export const step: PipelineStep = async (req, job) => {
  const mode = typeof req.options.mode === 'string' ? req.options.mode : 'write';
  switch (mode) {
    case 'not_mine':
      return { status: 'not_mine' };
    case 'failed':
      return { status: 'failed', warnings: ['the test package failed on purpose'] };
    case 'throw':
      throw new Error('the test package threw on purpose');
    case 'over':
      return {
        status: 'ok',
        calls: Array.from({ length: PIPELINE_CALLS_MAX + 1 }, () => ({
          call: 'worker' as const,
          worker: 'decider',
          input: {},
        })),
      };
    case 'loop':
      return {
        status: 'ok',
        calls: [{ call: 'worker', worker: 'decider', input: { step: req.step } }],
        state: { step: req.step },
      };
    case 'slow':
      await new Promise((r) => setTimeout(r, 60_000));
      return { status: 'ok' };
    case 'ask': {
      if (req.step === 1) {
        return {
          status: 'ok',
          calls: [
            {
              call: 'worker',
              worker: typeof req.options.worker === 'string' ? req.options.worker : 'decider',
              input: { size: req.file?.size ?? 0 },
            },
          ],
          state: { asked: true, kind: req.kind ?? null, asks: req.asks === true },
        };
      }
      const answer = req.answers?.[0];
      const state = (req.state ?? {}) as { asked?: boolean; kind?: string | null };
      return write({
        tabs: [
          {
            name: 'Answer',
            columns: [
              { name: 'Ok', type: 'checkbox' },
              { name: 'Output', type: 'text' },
              { name: 'Step', type: 'number' },
              { name: 'Asked', type: 'checkbox' },
            ],
            rows: [
              [
                answer?.ok === true,
                answer?.ok ? JSON.stringify(answer.output) : (answer?.error ?? null),
                req.step,
                state.asked === true,
              ],
            ],
          },
        ],
      });
    }
    case 'after': {
      const rows: (string | number | boolean | null)[][] = [];
      for await (const row of job.tabRows('Texts')) {
        rows.push(row.map((v) => (v === undefined ? null : (v as string | number | null))));
      }
      return write({
        tabs: [
          {
            name: 'Echo',
            columns: ['Text', 'Page', 'Layer', 'X', 'Y'].map((name) => ({ name, type: 'text' })),
            rows,
          },
        ],
      });
    }
    case 'picture': {
      await fs.writeFile(path.join(job.dir, 'pic.png'), Buffer.from('not really a png'));
      return write({
        tabs: [],
        text: 'the text of the test package',
        pictures: [{ file: 'pic.png', mime: 'image/png', caption: 'a picture' }],
      });
    }
    default: {
      const lines = (await job.bytes()).toString('utf8').split('\n').filter(Boolean);
      return write({
        tabs: [
          {
            name: 'Lines',
            columns: [{ name: 'Line', type: 'text' }],
            rows: lines.map((l) => [l]),
          },
        ],
        description: `${lines.length} lines, kind ${req.kind ?? 'none'}`,
      });
    }
  }
};
