/**
 * DB-loading wrapper around the pure config diff engine (./config-diff.ts).
 *
 * Loads the brain's live agent/skill/tool-group/worker rows (same query shape as
 * ./integrity.ts), stamps the template + last-reconciled versions, and runs the
 * pure `diffConfig`. Kept separate from config-diff.ts so the pure engine stays
 * DB-free and unit-testable. Read-only — surfaced at /settings/config.
 */

import { db, agents, skills, toolGroups, eq } from '@mantle/db';
import { loadProfilePreferences } from '@mantle/content';
import { listAiWorkers } from '@/lib/ai-workers';
import { APP_VERSION } from '@mantle/web-ui/version';
import { diffConfig, countStatuses, type ConfigDiffReport, type LiveConfig } from './config-diff';

export async function computeConfigDiff(ownerId: string): Promise<ConfigDiffReport> {
  const [agentRows, skillRows, toolGroupRows, workers, prefs] = await Promise.all([
    db
      .select({
        slug: agents.slug,
        name: agents.name,
        enabled: agents.enabled,
        role: agents.role,
        priority: agents.priority,
        skillSlugs: agents.skillSlugs,
        toolGroupSlugs: agents.toolGroupSlugs,
        model: agents.model,
        systemPrompt: agents.systemPrompt,
        memoryConfig: agents.memoryConfig,
      })
      .from(agents)
      .where(eq(agents.ownerId, ownerId)),
    db
      .select({
        slug: skills.slug,
        name: skills.name,
        enabled: skills.enabled,
        instructions: skills.instructions,
      })
      .from(skills)
      .where(eq(skills.ownerId, ownerId)),
    db
      .select({
        slug: toolGroups.slug,
        name: toolGroups.name,
        enabled: toolGroups.enabled,
        toolSlugs: toolGroups.toolSlugs,
      })
      .from(toolGroups)
      .where(eq(toolGroups.ownerId, ownerId)),
    listAiWorkers(ownerId),
    loadProfilePreferences(ownerId),
  ]);

  const live: LiveConfig = {
    agents: agentRows,
    skills: skillRows,
    toolGroups: toolGroupRows,
    workers: workers.map((w) => ({
      kind: w.kind,
      name: w.name,
      enabled: w.enabled,
      isDefault: w.isDefault ?? false,
      model: w.model,
    })),
  };

  const entities = diffConfig(live);
  return {
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    lastReconciledVersion: prefs.lastReconciledVersion ?? null,
    entities,
    counts: countStatuses(entities),
  };
}
