'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { SetPageTitle } from '@/components/layout/page-title';
import { ChangelogView } from './changelog-view';

type ChangelogResponse = {
  versions: string[];
  latest: string | null;
  version?: string;
  markdown: string | null;
};

/** Latest changelog entry — the file lives in the SERVER image (GET /api/changelog). */
export default function ChangelogPage() {
  const query = useQuery({
    queryKey: ['changelog', 'latest'],
    queryFn: () => apiFetch<ChangelogResponse>('/api/changelog'),
  });
  const data = query.data;

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 md:py-12">
        <SetPageTitle title="Changelog" />
        <p className="text-sm text-muted-foreground">
          {query.isError ? 'Could not load the changelog.' : 'Loading…'}
        </p>
      </div>
    );
  }
  if (!data.latest) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 md:py-12">
        <SetPageTitle title="Changelog" />
        <p className="text-sm text-muted-foreground">No changelog entries found yet.</p>
      </div>
    );
  }
  return (
    <>
      <SetPageTitle title="Changelog" />
      <ChangelogView
        version={data.latest}
        isLatest
        markdown={data.markdown ?? `# ${data.latest}\n\n(Empty changelog entry.)`}
        otherVersions={data.versions.filter((v) => v !== data.latest)}
      />
    </>
  );
}
