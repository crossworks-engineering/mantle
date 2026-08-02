/**
 * Shared invalidation for any mutation that touches agents. Three separate
 * surfaces cache agent data under different keys: the settings screens
 * (['agents'], plus derived keys like ['agents','options']), the permanently
 * mounted assistant panel (['assistant','thread', slug] feeds the header's
 * slug · model indicator and the AgentSelect dropdown), and Studio's composed
 * graph (['studio']). A save path that invalidates only its own key leaves the
 * others stale, and with the app-wide 30s staleTime, refetchOnWindowFocus off,
 * and the assistant panel hidden-but-never-unmounted, a stale indicator never
 * self-heals short of a full page refresh.
 *
 * Prefix invalidation is deliberate: ['assistant'] (not ['assistant','thread',
 * slug]) because the edited agent's slug is not necessarily the active panel
 * slug, and a slug rename would miss its own old key.
 */

import type { QueryClient } from '@tanstack/react-query';

/** Every query-key prefix that renders agent identity (name, role, model,
 *  avatar, enabled, priority) somewhere in the app. */
const AGENT_QUERY_PREFIXES: readonly string[][] = [['agents'], ['assistant'], ['studio']];

/** Invalidate all agent-derived caches after an agent mutation. Awaitable so
 *  callers that sequence work after invalidation (the models matrix) keep
 *  their ordering. */
export function invalidateAgentQueries(queryClient: QueryClient): Promise<void> {
  return Promise.all(
    AGENT_QUERY_PREFIXES.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);
}
