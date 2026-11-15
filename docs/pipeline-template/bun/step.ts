/**
 * The step of the LX-9 template (docs/pipelines.md, "Own pipelines"): it
 * reads the bytes of one `.lx9` file and gives the one write call, with
 * two tabs. A file that is not LX-9 is `not_mine`. It asks no AI worker
 * and calls no other tool: the core writes the tabs.
 */
import type { PipelineStep } from './mantle-pipeline';
import { readLx9 } from './read';

export const step: PipelineStep = async (req, job) => {
  const text = (await job.bytes()).toString('utf8');
  if (!text.startsWith('#LX9 ')) return { status: 'not_mine' };
  const lx = readLx9(text, Number(req.options.max_rows ?? 200000));
  return {
    status: 'ok',
    warnings: lx.cut ? [`Only the first ${lx.readings.length} readings were read.`] : [],
    calls: [
      {
        call: 'tool',
        tool: 'file_tabs_write',
        input: {
          tabs: [
            {
              name: 'Readings',
              columns: [
                { name: 'Time', type: 'text' },
                { name: 'Tag', type: 'text' },
                { name: 'Value', type: 'number' },
                { name: 'Unit', type: 'text' },
              ],
              rows: lx.readings,
            },
            {
              name: 'Header',
              columns: [
                { name: 'Key', type: 'text' },
                { name: 'Value', type: 'text' },
              ],
              rows: lx.header,
            },
          ],
          description: `LX-9 export: ${lx.tags.length} tags, ${lx.readings.length} readings, unit ${lx.unit || 'none'}.`,
        },
      },
    ],
  };
};
