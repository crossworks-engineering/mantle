import { notFound, redirect } from 'next/navigation';
import { getOwnedNode } from '@mantle/content';
import { requireOwner } from '@/lib/auth';

/**
 * Universal node permalink — `/n/<id>`. The one canonical, type-agnostic deep
 * link to any item in the user's Mantle. Responders embed this (via
 * {@link nodeUrl} in their tool results) so a reply can link to a document the
 * user clicks straight through to.
 *
 * The node row carries its own `type`, so a single route disambiguates every
 * kind: it loads the node owner-scoped, then redirects to the surface that
 * actually edits/displays it. Surfaces that already deep-link by id
 * (notes/tables/todos/lifelog via `?selected`, pages/apps/events via `/<id>`,
 * files via `?file=`, contacts via `?id=`) are reused as-is; anything without a
 * dedicated editor falls back to the universal `/nodes/<id>/history` biography,
 * which renders for every node type. Keeping the type→surface map HERE means
 * tools stay type-blind (they only ever hold an id) and links survive a
 * surface's URL shape changing.
 *
 * Owner-scoped at the loader; a leaked id for another owner 404s rather than
 * leaking existence via a permission error.
 */
export default async function NodePermalink({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;

  const row = await getOwnedNode(user.id, id);
  if (!row) notFound();

  const enc = encodeURIComponent(id);
  switch (row.type) {
    case 'note':
      redirect(`/notes?selected=${enc}`);
    case 'page':
      redirect(`/pages/${enc}`);
    case 'task':
      redirect(`/todos?selected=${enc}`);
    case 'table':
      redirect(`/tables?selected=${enc}`);
    case 'app':
      redirect(`/apps/${enc}`);
    case 'event':
      redirect(`/events/${enc}`);
    case 'file':
      redirect(`/files?file=${enc}`);
    case 'contact':
      redirect(`/contacts?id=${enc}`);
    case 'lifelog':
      redirect(`/lifelog?selected=${enc}`);
    default:
      // email, secret, location, telegram_message, sermon, documentation,
      // mantle_peer, printer_project, branch — no dedicated editor; the
      // generic node biography works for every type.
      redirect(`/nodes/${enc}/history`);
  }
}
