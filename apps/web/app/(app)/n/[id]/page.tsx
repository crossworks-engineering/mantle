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
 * (notes/tables/tasks/journal via `?selected`, pages/apps/events via `/<id>`,
 * files via `?file=`, contacts via `?id=`) are reused as-is; anything without a
 * dedicated editor falls back to the universal `/nodes/<id>/history` biography,
 * which renders for every node type. Keeping the type→surface map HERE means
 * tools stay type-blind (they only ever hold an id) and links survive a
 * surface's URL shape changing.
 *
 * Owner-scoped at the loader; a leaked id for another owner 404s rather than
 * leaking existence via a permission error.
 */
export default async function NodePermalink({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;

  const row = await getOwnedNode(user.id, id);
  if (!row) notFound();

  const enc = encodeURIComponent(id);
  // `redirect()` throws (returns `never`), so control never actually falls
  // through — but `return` makes that explicit and satisfies no-fallthrough
  // without the syntactic rule needing type info.
  switch (row.type) {
    case 'note':
      return redirect(`/notes?selected=${enc}`);
    case 'page':
      return redirect(`/pages/${enc}`);
    case 'task':
      return redirect(`/tasks?selected=${enc}`);
    case 'table':
      return redirect(`/tables?selected=${enc}`);
    case 'app':
      return redirect(`/apps/${enc}`);
    case 'event':
      return redirect(`/events/${enc}`);
    case 'file':
      return redirect(`/files?file=${enc}`);
    case 'contact':
      return redirect(`/contacts?id=${enc}`);
    case 'journal':
      return redirect(`/journal?selected=${enc}`);
    case 'formula':
      return redirect(`/formulas?id=${enc}`);
    case 'secret':
      return redirect(`/secrets/${enc}`);
    default:
      // email, location, telegram_message, sermon, documentation,
      // mantle_peer, printer_project, branch — no dedicated editor; the
      // generic node biography works for every type.
      return redirect(`/nodes/${enc}/history`);
  }
}
