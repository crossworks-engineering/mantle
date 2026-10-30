import { poolModelIssue } from '@mantle/client-types/model-pools';

/**
 * Does every OpenRouter route of a curated entry fit its pool? The one
 * save-time check for an entry, on add (POST /api/model-pools) and on edit
 * (PATCH /api/model-pools/:id), so a route or pool change cannot slip past
 * what an add refuses. Fail-open on the catalog like `poolModelIssue`; the
 * decider pool's refusal of a model that cannot take the request needs no
 * catalog. Returns the first reason, or null.
 */
export async function poolRoutesIssue(
  pool: string,
  routes: readonly { provider: string; model: string }[],
): Promise<string | null> {
  const orRoutes = routes.filter((r) => r.provider === 'openrouter');
  if (orRoutes.length === 0) return null;
  const { refreshModelCatalog, catalogModalities } = await import('@mantle/tracing');
  await refreshModelCatalog();
  for (const r of orRoutes) {
    const issue = poolModelIssue(pool, catalogModalities(r.model), r.model);
    if (issue) return issue;
  }
  return null;
}
