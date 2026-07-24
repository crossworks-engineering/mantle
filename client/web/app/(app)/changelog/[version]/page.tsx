'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';
import { SetPageTitle } from '@/components/layout/page-title';
import { ChangelogView } from '../changelog-view';

type ChangelogResponse = {
  versions: string[];
  latest: string | null;
  version?: string;
  markdown: string | null;
};

/** One changelog entry by version (GET /api/changelog?version=…; 404 → message). */
export default function ChangelogVersionPage({ params }: { params: Promise<{ version: string }> }) {
  const { version } = use(params);
  const query = useQuery({
    queryKey: ['changelog', version],
    queryFn: () =>
      apiFetch<ChangelogResponse>(`/api/changelog?version=${encodeURIComponent(version)}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const data = query.data;

  if (!data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 md:py-12">
        <SetPageTitle title="Changelog" />
        <p className="text-sm text-muted-foreground">
          {notFound
            ? 'No changelog entry for that version.'
            : query.isError
              ? 'Could not load the changelog.'
              : 'Loading…'}
        </p>
      </div>
    );
  }
  return (
    <>
      <SetPageTitle title="Changelog" />
      <ChangelogView
        version={version}
        isLatest={data.versions[0] === version}
        markdown={data.markdown ?? ''}
        otherVersions={data.versions.filter((v) => v !== version)}
      />
    </>
  );
}
