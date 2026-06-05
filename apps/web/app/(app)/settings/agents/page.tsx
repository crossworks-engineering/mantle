import { requireOwner } from '@/lib/auth';
import { listAgents } from '@/lib/agents';
import { listApiKeys } from '@/lib/api-keys';
import { listSkills } from '@/lib/skills';
import { listToolGroups } from '@/lib/tool-groups';
import { listAiWorkersByKind } from '@/lib/ai-workers';
import { getTailnetPeerNames } from '@/lib/tailscale';
import { SetPageTitle } from '@/components/layout/page-title';
import { AgentsClient } from './agents-client';

export default async function AgentsSettingsPage() {
  const user = await requireOwner();
  const [agents, keys, skillRows, toolGroupRows, tailnetPeers, ttsWorkers] = await Promise.all([
    listAgents(user.id),
    listApiKeys(user.id),
    listSkills(user.id),
    listToolGroups(user.id),
    getTailnetPeerNames(),
    listAiWorkersByKind(user.id, 'tts'),
  ]);

  return (
    <>
      <SetPageTitle title="Agents" />
      <AgentsClient
        initialAgents={agents}
        tailnetPeers={tailnetPeers}
        ttsWorkers={ttsWorkers.map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          provider: w.provider,
          model: w.model,
          enabled: w.enabled,
          isDefault: w.isDefault,
        }))}
        apiKeys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
        }))}
        availableSkills={skillRows
          .filter((s) => s.enabled)
          .map((s) => ({
            slug: s.slug,
            name: s.name,
            description: s.description,
          }))}
        availableToolGroups={toolGroupRows
          .filter((g) => g.enabled)
          .map((g) => ({
            slug: g.slug,
            name: g.name,
            description: g.description,
            toolSlugs: g.toolSlugs,
          }))}
      />
    </>
  );
}
