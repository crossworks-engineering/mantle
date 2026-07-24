'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@mantle/web-ui/api-fetch';

/**
 * Universal node permalink — `/n/<id>`. The one canonical, type-agnostic deep
 * link to any item in the user's Mantle. Responders embed this (via `nodeUrl`
 * in their tool results) so a reply can link to a document the user clicks
 * straight through to.
 *
 * Client-fetch flavor of the old SSR resolver: GET /api/nodes/[id] (owner-
 * scoped; a leaked id for another owner 404s rather than leaking existence)
 * returns the node's type, and the type→surface map below redirects to the
 * screen that edits/displays it. Keeping the map HERE means tools stay
 * type-blind (they only ever hold an id) and links survive a surface's URL
 * shape changing.
 */
function surfaceFor(type: string, id: string): string {
  const enc = encodeURIComponent(id);
  switch (type) {
    case 'note':
      return `/notes?selected=${enc}`;
    case 'page':
      return `/pages/${enc}`;
    case 'task':
      return `/tasks?selected=${enc}`;
    case 'table':
      return `/tables?selected=${enc}`;
    case 'app':
      return `/apps/${enc}`;
    case 'event':
      return `/events/${enc}`;
    case 'file':
      return `/files?file=${enc}`;
    case 'contact':
      return `/contacts?id=${enc}`;
    case 'journal':
      return `/journal?selected=${enc}`;
    case 'formula':
      return `/formulas?id=${enc}`;
    case 'secret':
      return `/secrets/${enc}`;
    default:
      // email, location, telegram_message, sermon, documentation, mantle_peer,
      // printer_project, branch — no dedicated editor; the generic node
      // biography works for every type.
      return `/nodes/${enc}/history`;
  }
}

export default function NodePermalink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const nodeQuery = useQuery({
    queryKey: ['node-permalink', id],
    queryFn: () => apiFetch<{ node: { type: string } }>(`/api/nodes/${encodeURIComponent(id)}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  useEffect(() => {
    if (nodeQuery.data) router.replace(surfaceFor(nodeQuery.data.node.type, id));
  }, [nodeQuery.data, router, id]);

  if (nodeQuery.isError) {
    return <p className="p-6 text-sm text-muted-foreground">This item does not exist.</p>;
  }
  return <p className="p-6 text-sm text-muted-foreground">Opening…</p>;
}
