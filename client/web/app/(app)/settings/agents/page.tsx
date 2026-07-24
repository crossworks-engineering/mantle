import { SetPageTitle } from '@/components/layout/page-title';
import { AgentsClient } from './agents-client';

/**
 * Auth gate only — all data (agents, keys, skills, tool groups, tailnet peers,
 * TTS workers) is fetched client-side via TanStack Query against `/api/**` so
 * the screen carries no in-process DB read (Electron / DB-less ready). See
 * `docs/client-data-fetching.md`.
 */
export default async function AgentsSettingsPage() {
  return (
    <>
      <SetPageTitle title="Agents" />
      <AgentsClient />
    </>
  );
}
