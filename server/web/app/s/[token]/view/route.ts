import { NextResponse } from '@/server/http-compat';
import { shareModeOf } from '@mantle/content';
import { buildPageToc } from '@mantle/content/page-toc';
import type { ShareViewPayload } from '@mantle/web-ui/share/view-payload';
import { resolveActiveShareByToken, loadShareView, recordShareView } from '@/lib/shares';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';
import { renderPageDoc } from '@/lib/render-page-doc';
import { loadFolderListing } from '@/components/share/folder-presenter';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * The share view as JSON — the content door for the /team INLINE reader (the
 * client app renders the presenter itself; no /s iframe). Same data the /s
 * HTML page renders, same authorization (active token + live team session for
 * team mode), with one deliberate difference in the failure shape: a missing
 * session answers 401 (the caller is our own UI holding a credential, not a
 * human who needs a token prompt). Invalid/revoked tokens 404 uniformly.
 *
 * Accepts the team bearer as well as the cookie (resolveShareVisitorFromRequest)
 * and is CORS-eligible via SHARE_BROKER_RE — same treatment as the app brokers.
 *
 * Pages ship pre-rendered sanitized HTML + toc: renderPageDoc's escaping stays
 * server-side and katex/lowlight stay out of the client bundle. Folders ship
 * the listing for `?p=` (validated against the shared root, as the HTML page
 * does). Asset/embed URLs are relative /s/<token>/… paths — correct for the
 * same-origin deployment shape the inline reader targets.
 */

function notFound() {
  return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok, retryAfterSec } = rateLimit(`share-view:${clientIp(req)}`, {
    max: 120,
    windowMs: 60_000,
  });
  if (!ok) {
    return NextResponse.json(
      { error: 'too many requests' },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
      },
    );
  }

  const share = await resolveActiveShareByToken(token);
  if (!share) return notFound();

  const visitor = await resolveShareVisitorFromRequest(req, share);
  if (!visitor) {
    return NextResponse.json(
      { error: 'team session required' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  const view = await loadShareView(share);
  if (!view) return notFound();

  void recordShareView(share.id); // fire-and-forget, same as the HTML page

  const assetUrl = (fileId: string) => `/s/${token}/a/${fileId}`;

  let payload: ShareViewPayload;
  switch (view.kind) {
    case 'page':
      payload = {
        kind: 'page',
        title: view.title,
        icon: view.icon,
        width: view.width,
        html: renderPageDoc(view.doc, { assetUrl }),
        toc: buildPageToc(view.doc),
      };
      break;
    case 'folder': {
      const p = new URL(req.url).searchParams.get('p') ?? '';
      const listing = await loadFolderListing(share.ownerId, view, p);
      payload = {
        kind: 'folder',
        title: view.title,
        path: view.path,
        listing: {
          currentPath: listing.currentPath,
          folders: listing.folders.map((f) => ({
            id: f.id,
            path: f.path,
            slug: f.slug,
            fileCount: f.fileCount,
          })),
          files: listing.files.map((f) => ({
            id: f.id,
            filename: f.filename,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
          })),
        },
      };
      break;
    }
    default:
      // note/task/event/file/app/table/formula: the presenter's props verbatim.
      payload = view;
  }

  return NextResponse.json(
    { mode: shareModeOf(share), view: payload },
    { headers: { 'cache-control': 'no-store' } },
  );
}
