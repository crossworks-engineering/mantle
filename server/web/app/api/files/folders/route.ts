import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  createFolder,
  ensureFilesRootBranch,
  listAllFoldersWithTrail,
  listFoldersWithTrail,
} from '@/lib/files';
import { capped } from '@/lib/list-workspaces';
import { firstIssue } from '@/lib/zod-issue';
import { conflictOnUnique } from '@mantle/db';
import { readJson } from '@/lib/read-body';

const ListQuery = z.object({
  parent: z.string().optional(),
  tree: z.coerce.boolean().optional(),
});

/** GET /api/files/folders?parent=|tree=: the Files folders the caller reads
 *  and, for a login's own session, the folders above what it reads as
 *  structure (id, path, name), each with the caller's caps (`mayEdit`,
 *  `mayManage`; none on a folder it does not read, so a client offers no
 *  write there, and every write still answers 404 for it). */
export async function GET(req: Request) {
  const user = ownerCaller();
  await ensureFilesRootBranch(user.id);
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  if (parsed.data.tree) {
    const all = await listAllFoldersWithTrail(user.id);
    return NextResponse.json({ folders: await capped(all) });
  }
  const parent = parsed.data.parent ?? 'files';
  const folders = await listFoldersWithTrail({ ownerId: user.id, parentPath: parent });
  return NextResponse.json({ folders: await capped(folders) });
}

const CreateBody = z.object({
  parentPath: z.string().min(1).max(500),
  slug: z.string().min(1).max(64),
  description: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  await ensureFilesRootBranch(user.id);
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  // A slug or name taken answers 409 with this route's own text
  // (conflictOnUnique, a ConflictError); anything else answers by the one
  // table (A10 part 2): a domain error its status, a fault the opaque 500.
  return conflictOnUnique(`A folder with that slug already exists under this parent.`, async () => {
    const folder = await createFolder({
      ownerId: user.id,
      parentPath: parsed.data.parentPath,
      slug: parsed.data.slug,
      description: parsed.data.description,
    });
    return NextResponse.json({ folder });
  });
}
