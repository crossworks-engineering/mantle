import { SetPageTitle } from '@/components/layout/page-title';
import { SecretsClient } from './secrets-client';

/**
 * Secrets list: data-free. The page only parses the URL params (search / kind /
 * page) and hands them to SecretsClient, which fetches the page of secret
 * metadata from GET /api/secrets via useQuery. `useListNav` keeps the params in
 * the URL. Secret values are never listed — reveal is a separate endpoint.
 */
export default async function SecretsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; kind?: string }>;
}) {
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || '';
  const kind = sp.kind?.trim() || 'all';

  return (
    <>
      <SetPageTitle title="Secrets" />
      <SecretsClient page={page} query={query} kind={kind} />
    </>
  );
}
