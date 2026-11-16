/**
 * The step of the Agent `iso-title-block`, with a fake of the parser's
 * picture helper: two vision asks with the same fields, one for each
 * picture the helper wrote; `not_mine` when the file is none of its
 * formats; never a write. Pure: no parser, no model.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_PIPELINES, asksMaxOf } from '../../builtin';
import {
  PIPELINE_API,
  PIPELINE_ASK_FIELDS_MAX,
  PIPELINE_ASK_FIELD_NAME_MAX,
  PIPELINE_ASK_HINT_MAX,
  VISION_WORKER,
  type PictureAskInput,
  type PipelineStepRequest,
  type StepJob,
} from '../../contract';
import { checkStepResult } from '../../step-check';
import { inProcessStepJob } from '../../test-job';
import { FIELDS, step } from './step';

const request = (ext: string): PipelineStepRequest => ({
  api: PIPELINE_API,
  step: 1,
  file: { name: `made-up.${ext}`, ext, size: 1, sha256: '0'.repeat(64) },
  options: {},
  asks: true,
});

/** A job whose picture helper answers `reply`, and keeps what it was asked. */
function jobOf(reply: Awaited<ReturnType<StepJob['sheetPictures']>>) {
  const asked: Parameters<StepJob['sheetPictures']>[0][] = [];
  const job = inProcessStepJob(Buffer.from('made-up'), '/nowhere', {
    sheetPictures: async (spec) => {
      asked.push(spec);
      return reply;
    },
  });
  return { job, asked };
}

const sheet = (pictures: string[]) => ({
  format: 'TIFF raster',
  widthMm: 841,
  heightMm: 594,
  pictures,
});

describe('the step of iso-title-block', () => {
  it('cuts the whole sheet and the right side, and asks the vision worker for each, with the same fields', async () => {
    const { job, asked } = jobOf(sheet(['sheet.png', 'right-side.png']));
    const result = await step(request('TIF'), job);
    expect(asked).toEqual([
      {
        ext: 'tif',
        pictures: [
          { file: 'sheet.png', part: [0, 0, 1, 1], maxSide: 2800, dpiCap: undefined },
          { file: 'right-side.png', part: [0.8, 0, 1, 1], maxSide: 4000, dpiCap: 200 },
        ],
      },
    ]);
    expect(result).toEqual({
      status: 'ok',
      calls: [
        {
          call: 'worker',
          worker: VISION_WORKER,
          key: 'sheet',
          input: { picture: 'sheet.png', fields: FIELDS },
        },
        {
          call: 'worker',
          worker: VISION_WORKER,
          key: 'right-side',
          input: { picture: 'right-side.png', fields: FIELDS },
        },
      ],
    });
    // No write, no state, no second step: the core writes the rows.
    expect(result.calls!.some((c) => c.call === 'tool')).toBe(false);
    expect(result.state).toBeUndefined();
    // What is sent passes the one check of a result.
    const checked = checkStepResult(JSON.parse(JSON.stringify(result)));
    expect(checked.ok).toBe(true);
    // No more asks than its manifest allows.
    const manifest = BUILTIN_PIPELINES.find((p) => p.id === 'iso-title-block')!;
    expect(result.calls!.length).toBeLessThanOrEqual(asksMaxOf(manifest));
  });

  it('asks only for a picture the helper wrote', async () => {
    const { job } = jobOf(sheet(['right-side.png']));
    const result = await step(request('smf'), job);
    expect(result.status).toBe('ok');
    expect(result.calls!.map((c) => (c.call === 'worker' ? c.key : c.call))).toEqual([
      'right-side',
    ]);
    expect((result.calls![0] as { input: PictureAskInput }).input.picture).toBe('right-side.png');
    const none = await step(request('smf'), jobOf(sheet([])).job);
    expect(none).toEqual({ status: 'ok', calls: [] });
  });

  it('a file that is none of its formats is not_mine, with no call', async () => {
    const result = await step(request('000'), jobOf(null).job);
    expect(result).toEqual({ status: 'not_mine' });
    expect(checkStepResult(result).ok).toBe(true);
  });

  it('the fields: the seven of the tab, each with a short hint, in the limits of an ask', () => {
    expect(FIELDS.map((f) => f.name)).toEqual([
      'Line number',
      'Revision',
      'Date',
      'Sheet',
      'Drawn by',
      'Checked by',
      'TML total',
    ]);
    expect(FIELDS.length).toBeLessThanOrEqual(PIPELINE_ASK_FIELDS_MAX);
    for (const f of FIELDS) {
      expect(f.name.length, f.name).toBeLessThanOrEqual(PIPELINE_ASK_FIELD_NAME_MAX);
      expect(f.hint, f.name).toBeTruthy();
      expect(f.hint!.length, f.name).toBeLessThanOrEqual(PIPELINE_ASK_HINT_MAX);
      // The fixed columns of an Agent's tab are not field names.
      expect(['Key', 'Model', 'Input hash']).not.toContain(f.name);
    }
  });
});
