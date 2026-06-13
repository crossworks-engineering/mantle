import { notFound } from 'next/navigation';
import { SetPageTitle } from '@/components/layout/page-title';
import { getChangelogMarkdown, listChangelogVersions } from '@/lib/changelog';
import { ChangelogView } from '../changelog-view';

export const dynamic = 'force-dynamic';

export default async function ChangelogVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const markdown = await getChangelogMarkdown(version);
  if (markdown === null) notFound();

  const versions = await listChangelogVersions();

  return (
    <>
      <SetPageTitle title="Changelog" />
      <ChangelogView
        version={version}
        isLatest={versions[0] === version}
        markdown={markdown}
        otherVersions={versions.filter((v) => v !== version)}
      />
    </>
  );
}
