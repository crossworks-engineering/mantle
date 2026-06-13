import { SetPageTitle } from '@/components/layout/page-title';
import {
  getChangelogMarkdown,
  getLatestChangelogVersion,
  listChangelogVersions,
} from '@/lib/changelog';
import { ChangelogView } from './changelog-view';

export const dynamic = 'force-dynamic';

export default async function ChangelogPage() {
  const versions = await listChangelogVersions();
  const latest = await getLatestChangelogVersion();

  if (!latest) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 md:py-12">
        <SetPageTitle title="Changelog" />
        <p className="text-sm text-muted-foreground">No changelog entries found yet.</p>
      </div>
    );
  }

  const markdown = (await getChangelogMarkdown(latest)) ?? `# ${latest}\n\n(Empty changelog entry.)`;

  return (
    <>
      <SetPageTitle title="Changelog" />
      <ChangelogView
        version={latest}
        isLatest
        markdown={markdown}
        otherVersions={versions.filter((v) => v !== latest)}
      />
    </>
  );
}
