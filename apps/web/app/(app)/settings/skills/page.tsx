import { eq } from 'drizzle-orm';
import { db, tools } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { listSkills, listSkillBackrefs } from '@/lib/skills';
import { SetPageTitle } from '@/components/layout/page-title';
import { SkillsClient } from './skills-client';

export default async function SkillsPage() {
  const user = await requireOwner();
  const [skillRows, toolRows, backrefs] = await Promise.all([
    listSkills(user.id),
    db
      .select({
        slug: tools.slug,
        name: tools.name,
        description: tools.description,
        requiresConfirm: tools.requiresConfirm,
        handler: tools.handler,
      })
      .from(tools)
      .where(eq(tools.ownerId, user.id))
      .orderBy(tools.slug),
    listSkillBackrefs(user.id),
  ]);
  // Flatten the backrefs Map → plain object for the client component.
  // Client components can't receive Maps directly (not serializable
  // across the boundary).
  const backrefsRecord: Record<string, Array<{ slug: string; name: string; status: string }>> = {};
  for (const [k, v] of backrefs.entries()) backrefsRecord[k] = v;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <SetPageTitle title="Skills" />
      <SkillsClient
        initialSkills={skillRows}
        availableTools={toolRows.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          requiresConfirm: t.requiresConfirm,
          kind: (t.handler as { kind: string }).kind,
        }))}
        heartbeatBackrefs={backrefsRecord}
      />
    </div>
  );
}
