/**
 * Node biography page — `/nodes/<id>/history`.
 *
 * Deep-linkable from anywhere (file detail pages, /traces rows where
 * subject_kind='node', /debug, MCP responses). Works for every node
 * type — files, notes, tasks, events, telegram_messages — because
 * the biography is built from generic node + traces joins, not
 * type-specific queries.
 *
 * Data-free: NodeHistoryClient fetches the fully-resolved biography from
 * GET /api/nodes/[id]/history (owner-scoped; 404, not 403, for a leaked id so
 * existence doesn't leak) and renders the presentational NodeBiography.
 */

import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import { NodeHistoryClient } from './node-history-client';

export default async function NodeHistoryPage(props: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await props.params;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Node history" />
      <header className="space-y-1">
        <BackLink href="/files">Files</BackLink>
      </header>

      <NodeHistoryClient id={id} />
    </div>
  );
}
