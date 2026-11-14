/**
 * The step of `site-tags`, an `after` pipeline: the rows of the `Texts` tab
 * of a drawing's database to the tab `Site tags` (./site-tags.ts). One step,
 * one write call, with the warnings. It runs in the parser job
 * `pipelineRun`, and it never gets the file: its body is the tabs of the
 * shape `texts-v1` (../../tabs-body.ts), which the core writes from the
 * database with the row cap and the cell cap (afterBodyOf). The core adds
 * the warning of the row cap itself.
 *
 * A row comes in the order of the shape's columns (Text, Page, Layer, X,
 * Y), a missing column as null, and is read by name, as the read in the
 * core gave it before the move.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { SHAPES } from '../../shapes';
import { siteProfileOf, siteTagsBuilder, type TextRow } from './site-tags';

const TEXTS = SHAPES['texts-v1'].tabs.find((t) => t.name === 'Texts')!;

export const step: PipelineStep = async (req, job) => {
  const tags = siteTagsBuilder(siteProfileOf(req.options));
  for await (const row of job.tabRows(TEXTS.name)) {
    const named = Object.fromEntries(TEXTS.columns.map((c, i) => [c, row[i] ?? null]));
    if (!tags.add(named as TextRow)) break;
  }
  const { sheet, warnings } = tags.done();
  return {
    status: 'ok',
    calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: [sheet] } }],
    warnings,
  };
};
