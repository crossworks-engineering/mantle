/**
 * The step of plan-mspdi on a native Project file (.mpp, .mpt): an OLE2
 * body goes through the parser's converter (job.mppToMspdi) first, then is
 * read as the XML plan it gives. The converter is the parser's alone; here
 * a fake gives a made-up MSPDI fixture. The real converter on made-up .mpp
 * samples is tested through a real parser job
 * (packages/content/src/pipeline-runner.test.ts, "a native Project file").
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIPELINE_API, type PipelineStepResult } from '../../contract';
import { inProcessStepJob } from '../../test-job';
import { isOle2 } from '../../../mspdi-sniff';
import { step } from './step';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN_XML = readFileSync(path.join(HERE, 'fixtures', 'normal.xml'));
/** The eight bytes of an OLE2 compound file, then made-up bytes. */
const OLE2 = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('made-up'),
]);
const REQ = { api: PIPELINE_API, step: 1, options: {} };

function tabsOf(result: PipelineStepResult): string[] {
  const write = result.calls?.find((c) => c.call === 'tool');
  return ((write?.input as { tabs?: { name: string }[] } | undefined)?.tabs ?? []).map(
    (t) => t.name,
  );
}

describe('plan-mspdi on a native Project file', () => {
  it('an OLE2 body is converted first, then read as the plan it gives', async () => {
    let asked = 0;
    const job = inProcessStepJob(OLE2, '/nowhere', {
      mppToMspdi: async () => {
        asked += 1;
        return PLAN_XML;
      },
    });
    const result = await step(REQ, job);
    expect(asked).toBe(1);
    expect(result.status).toBe('ok');
    expect(tabsOf(result)).toEqual(['Tasks', 'Resources', 'Assignments']);
  });

  it('an XML body is never sent to the converter', async () => {
    const job = inProcessStepJob(PLAN_XML, '/nowhere', {
      mppToMspdi: async () => {
        throw new Error('not for an XML');
      },
    });
    const result = await step(REQ, job);
    expect(tabsOf(result)).toEqual(['Tasks', 'Resources', 'Assignments']);
  });

  it("a file the converter refuses fails the step with the converter's reason", async () => {
    const job = inProcessStepJob(OLE2, '/nowhere', {
      mppToMspdi: async () => {
        throw new Error('The Project file is password protected, so it cannot be read.');
      },
    });
    await expect(step(REQ, job)).rejects.toThrow(/password protected/);
  });

  it('isOle2 takes the eight bytes of the container only', () => {
    expect(isOle2(OLE2)).toBe(true);
    expect(isOle2(PLAN_XML)).toBe(false);
    expect(isOle2(OLE2.subarray(0, 7))).toBe(false);
  });
});
