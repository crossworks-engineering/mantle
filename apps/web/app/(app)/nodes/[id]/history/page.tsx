/**
 * Node biography page — `/nodes/<id>/history`.
 *
 * Deep-linkable from anywhere (file detail pages, /traces rows where
 * subject_kind='node', /debug, MCP responses). Works for every node
 * type — files, notes, todos, events, telegram_messages — because
 * the biography is built from generic node + traces joins, not
 * type-specific queries.
 *
 * Owner-scoped at the loader; an attacker passing a leaked node id
 * for another owner gets a 404, not a permission error (less
 * informative for probing).
 */

import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { loadNodeBiography } from '@/lib/node-biography';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { NodeBiography } from '@/components/node-biography';

export default async function NodeHistoryPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const user = await requireOwner();
  const view = await loadNodeBiography(user.id, id);
  if (!view) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Node history" />
      <header className="space-y-1">
        <BackLink href="/files">Files</BackLink>
      </header>

      <NodeBiography view={view} />
    </div>
  );
}
