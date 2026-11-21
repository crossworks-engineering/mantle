/**
 * The step of `links`, an `after` pipeline: the tabs of a file of pages
 * (the shape `pages-v1`, ../../shapes.ts) to the tabs `Links` and `Link
 * nodes` (./links.ts). One step, one write call, with the warnings. It runs
 * in the parser job `pipelineRun`, and it never gets the file: its body is
 * the tabs the core writes from the database (../../tabs-body.ts,
 * afterBodyOf), which for this shape holds a book's table tabs too, each
 * with all its columns. So the step reads the body's head lines itself.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { buildLinks, linkInputOf, LINKS_FTS_SKIP, type BodyTab } from './links';
import { LINK_PACKS } from './packs';

/** The tabs of a body: a head line `{"tab", "columns"}`, then one JSON
 *  array a row. A line that is not JSON throws: the body is the core's. */
export function bodyTabsOf(body: string): Map<string, BodyTab> {
  const tabs = new Map<string, { columns: string[]; rows: unknown[][] }>();
  let current: { columns: string[]; rows: unknown[][] } | null = null;
  for (const line of body.split('\n')) {
    if (line === '') continue;
    const value = JSON.parse(line) as unknown;
    if (Array.isArray(value)) {
      current?.rows.push(value);
      continue;
    }
    const head = value as { tab?: unknown; columns?: unknown };
    if (typeof head.tab !== 'string' || !Array.isArray(head.columns)) {
      current = null;
      continue;
    }
    current = { columns: head.columns.map(String), rows: [] };
    if (!tabs.has(head.tab)) tabs.set(head.tab, current);
  }
  return tabs;
}

export const step: PipelineStep = async (_req, job) => {
  const input = linkInputOf(bodyTabsOf((await job.bytes()).toString('utf8')));
  const { sheets, warnings, packsOn } = buildLinks(input, LINK_PACKS);
  const links = sheets[0]?.rows.length ?? 0;
  return {
    status: 'ok',
    calls:
      sheets.length > 0
        ? [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: sheets, ftsSkipColumns: LINKS_FTS_SKIP } }]
        : [],
    warnings,
    counts: { links, nodes: sheets[1]?.rows.length ?? 0, packs: packsOn.length },
  };
};
