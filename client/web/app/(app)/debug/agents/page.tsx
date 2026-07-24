import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { AgentsClient } from './agents-client';

/** Debug → Agents: configured agents + the reflector's persona notes. Data-free
 *  — AgentsClient fetches GET /api/debug/agents. */
export default async function DebugAgentsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Agents" />
      <AgentsClient />
    </div>
  );
}
