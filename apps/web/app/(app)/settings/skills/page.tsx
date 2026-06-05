import { requireOwner } from '@/lib/auth';
import { listSkills, listSkillBackrefs } from '@/lib/skills';
import { SetPageTitle } from '@/components/layout/page-title';
import { SkillsClient } from './skills-client';

export default async function SkillsPage() {
  const user = await requireOwner();
  const [skillRows, backrefs] = await Promise.all([
    listSkills(user.id),
    listSkillBackrefs(user.id),
  ]);
  // Flatten the backrefs Map → plain object for the client component.
  // Client components can't receive Maps directly (not serializable
  // across the boundary).
  const backrefsRecord: Record<string, Array<{ slug: string; name: string; status: string }>> = {};
  for (const [k, v] of backrefs.entries()) backrefsRecord[k] = v;

  return (
    <>
      <SetPageTitle title="Skills" />
      <SkillsClient initialSkills={skillRows} heartbeatBackrefs={backrefsRecord} />
    </>
  );
}
