import { NextResponse } from '@/server/http-compat';
import { SUPPORTED_PROVIDERS, isProviderId, type ProviderId } from '@mantle/voice';
import { getOwnerOr401 } from '@/lib/auth';
import {
  fetchProviderModels,
  explorerCanFetch,
  queryModels,
  type ModelSort,
} from '@/lib/model-explorer';

/**
 * GET /api/models/explore?provider=&q=&sort=&kind=&page=
 *
 * The full /models explorer bundle the page used to compute server-side: the
 * provider list, the selected provider's catalog meta, and the
 * filtered/sorted/paginated rows + kinds. Owner-scoped; the provider's stored
 * API key is resolved server-side and never leaves this route. (Cache busting
 * stays on GET /api/models?refresh=1 so it audits distinctly.)
 */
const PAGE_SIZE = 50;
const SORTS: ModelSort[] = ['name', 'context', 'input', 'output', 'created'];

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);

  const provider: ProviderId = isProviderId(url.searchParams.get('provider') ?? '')
    ? (url.searchParams.get('provider') as ProviderId)
    : 'openrouter';
  const q = url.searchParams.get('q')?.trim() || undefined;
  const sortParam = url.searchParams.get('sort') ?? '';
  const sort: ModelSort = SORTS.includes(sortParam as ModelSort)
    ? (sortParam as ModelSort)
    : 'name';
  const kind = url.searchParams.get('kind')?.trim() || 'all';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

  const result = await fetchProviderModels(user.id, provider);
  const { rows, total, kinds } = queryModels(result.models, {
    q,
    kind,
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const providers = SUPPORTED_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    signupUrl: p.signupUrl,
    docsUrl: p.docsUrl,
    isAggregator: p.isAggregator ?? false,
    canFetch: explorerCanFetch(p.id),
  }));

  return NextResponse.json({
    providers,
    provider,
    meta: {
      needsKey: result.needsKey ?? false,
      unsupported: result.unsupported ?? false,
      error: result.error ?? null,
      fetchedAt: result.fetchedAt,
    },
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    q: q ?? '',
    sort,
    kind,
    kinds,
  });
}
