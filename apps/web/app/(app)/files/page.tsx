import { requireOwner } from '@/lib/auth';
import {
  ensureFilesRootBranch,
  folderByPath,
  listAllFolders,
  listFiles,
} from '@/lib/files';
import { FilesClient } from './files-client';

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const user = await requireOwner();
  await ensureFilesRootBranch(user.id);

  const sp = await searchParams;
  const currentPath = sp.path && sp.path.length > 0 ? sp.path : 'files';

  // Validate the requested path actually exists; fall back to root.
  let resolved = currentPath;
  let folder = await folderByPath({ ownerId: user.id, path: resolved });
  if (!folder) {
    resolved = 'files';
    folder = await folderByPath({ ownerId: user.id, path: 'files' });
  }

  const [tree, files] = await Promise.all([
    listAllFolders(user.id),
    listFiles({ ownerId: user.id, parentPath: resolved }),
  ]);

  return (
    <FilesClient
      tree={tree}
      currentPath={resolved}
      currentFolder={folder ?? null}
      files={files}
    />
  );
}
