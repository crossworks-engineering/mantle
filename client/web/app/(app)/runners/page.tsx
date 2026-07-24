import { SetPageTitle } from '@/components/layout/page-title';
import { RUNNER_STATUSES } from '@mantle/web-ui/runners-types';
import { RunnersClient } from './runners-client';

type SearchParams = {
  status?: string | string[];
  name?: string;
  hours?: string;
  page?: string;
  selected?: string;
};

const VALID = new Set<string>(RUNNER_STATUSES);

/**
 * Runners: Mantle's in-app DBOS admin console. Data-free — the page parses URL
 * state (status filters / name / window / page / selected) and hands it to
 * RunnersClient, which fetches the run list (GET /api/runners), the queue health
 * + names (GET /api/runners/meta), and the selected run (GET /api/runners/[id]).
 */
export default async function RunnersPage(props: { searchParams?: Promise<SearchParams> }) {
  const sp = (await props.searchParams) ?? {};

  const statuses = toArray(sp.status).filter((s) => VALID.has(s));
  const name = sp.name?.trim() || null;
  const hours = sp.hours ? parseInt(sp.hours, 10) || 0 : 0;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const selected = sp.selected ?? null;

  return (
    <>
      <SetPageTitle title="Runners" />
      <RunnersClient
        statuses={statuses}
        name={name}
        hours={hours}
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
