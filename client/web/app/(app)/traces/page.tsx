import type { TraceSort, TraceSortDir } from '@mantle/web-ui/traces-format';
import { SetPageTitle } from '@/components/layout/page-title';
import { TracesClient } from './traces-client';

type SearchParams = {
  kind?: string | string[];
  status?: string | string[];
  hours?: string;
  sort?: string;
  dir?: string;
  page?: string;
  selected?: string;
};

/**
 * Traces: data-free. The page only parses the URL state (filters / sort / page /
 * selected) and hands it to TracesClient, which fetches the list (GET /api/traces)
 * and the selected trace (GET /api/traces/[id]) via useQuery.
 */
export default async function TracesPage(props: { searchParams?: Promise<SearchParams> }) {
  const sp = (await props.searchParams) ?? {};

  const kinds = toArray(sp.kind);
  const statuses = toArray(sp.status);
  const hours = sp.hours ? parseInt(sp.hours, 10) || 24 : 24;
  const sort: TraceSort = sp.sort === 'cost' || sp.sort === 'duration' ? sp.sort : 'started';
  const dir: TraceSortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const selected = sp.selected ?? null;

  return (
    <>
      <SetPageTitle title="Traces" />
      <TracesClient
        kinds={kinds}
        statuses={statuses}
        hours={hours}
        sort={sort}
        dir={dir}
        page={page}
        selected={selected}
      />
    </>
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
