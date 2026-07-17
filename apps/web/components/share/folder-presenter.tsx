import Link from 'next/link';
import { Download, File as FileIcon, Folder as FolderIcon } from 'lucide-react';
import { listFolders, listFiles, folderByPath, ltreeToDash } from '@/lib/files';
import { formatBytes } from '@/lib/format-bytes';

/**
 * Public folder render: a read-only listing of the shared folder's subtree.
 * Server component — it queries the listing itself, scoped to the SHARED
 * folder: `sub` (the ?p= search param) is validated to be a real descendant
 * of the shared root before anything is listed, so a crafted ?p= can never
 * escape the share. Files are download-only, served from the scoped asset
 * route (which independently re-checks subtree membership per request).
 */

/** Path segments are ltree labels — allow only label characters and dots so a
 *  crafted `?p=` can't smuggle lquery/ltree syntax into queries. */
const SUBPATH_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

export async function FolderPresenter({
  view,
  ownerId,
  sub,
  assetUrl,
  makeSubHref,
}: {
  view: { folderId: string; title: string; path: string };
  ownerId: string;
  /** Relative subpath under the shared folder (from ?p=), '' for the root. */
  sub: string;
  assetUrl: (fileId: string) => string;
  makeSubHref: (sub: string) => string;
}) {
  // Resolve the folder being viewed: the shared root, or a validated
  // descendant of it. Anything suspicious falls back to the root.
  let currentPath = view.path;
  if (sub && SUBPATH_RE.test(sub)) {
    const candidate = `${view.path}.${sub}`;
    const folder = await folderByPath({ ownerId, path: candidate });
    if (folder) currentPath = candidate;
  }

  const [folders, files] = await Promise.all([
    listFolders({ ownerId, parentPath: currentPath }),
    listFiles({ ownerId, parentPath: currentPath }),
  ]);

  // Breadcrumb: shared root ▸ …descendant labels (never above the share).
  // Labels display in dash form (the disk slug the folder cards show); the
  // sub links keep the raw ltree form the ?p= round-trip matches on.
  const relLabels = currentPath === view.path ? [] : currentPath.slice(view.path.length + 1).split('.');
  const crumbs = [
    { label: view.title, sub: '' },
    ...relLabels.map((label, i) => ({
      label: ltreeToDash(label),
      sub: relLabels.slice(0, i + 1).join('.'),
    })),
  ];

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-6">
        <h1 className="text-center text-xl font-semibold tracking-tight">{view.title}</h1>
        <nav className="mt-2 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={c.sub} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>/</span>}
              {i === crumbs.length - 1 ? (
                <span className="text-foreground">{c.label}</span>
              ) : (
                <Link href={makeSubHref(c.sub)} className="hover:text-foreground hover:underline">
                  {c.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
      </header>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {folders.map((f) => {
          const childSub = f.path.slice(view.path.length + 1);
          return (
            <li key={f.id}>
              <Link
                href={makeSubHref(childSub)}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
              >
                <FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.slug}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {f.fileCount} file{f.fileCount === 1 ? '' : 's'}
                </span>
              </Link>
            </li>
          );
        })}
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-3">
            <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.filename}</p>
              <p className="text-xs text-muted-foreground">
                {f.mimeType || 'file'} · {formatBytes(f.sizeBytes)}
              </p>
            </div>
            <a
              href={assetUrl(f.id)}
              download={f.filename}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <Download className="size-4" aria-hidden /> Download
            </a>
          </li>
        ))}
        {folders.length === 0 && files.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">This folder is empty.</li>
        )}
      </ul>
    </div>
  );
}
