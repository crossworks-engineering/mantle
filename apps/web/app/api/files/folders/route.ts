import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  createFolder,
  ensureFilesRootBranch,
  listAllFolders,
  listFolders,
} from '@/lib/files';

const ListQuery = z.object({
  parent: z.string().optional(),
  tree: z.coerce.boolean().optional(),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await ensureFilesRootBranch(user.id);
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  if (parsed.data.tree) {
    const all = await listAllFolders(user.id);
    return NextResponse.json({ folders: all });
  }
  const parent = parsed.data.parent ?? 'files';
  const folders = await listFolders({ ownerId: user.id, parentPath: parent });
  return NextResponse.json({ folders });
}

const CreateBody = z.object({
  parentPath: z.string().min(1).max(500),
  slug: z.string().min(1).max(64),
  description: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await ensureFilesRootBranch(user.id);
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const folder = await createFolder({
      ownerId: user.id,
      parentPath: parsed.data.parentPath,
      slug: parsed.data.slug,
      description: parsed.data.description,
    });
    return NextResponse.json({ folder });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('nodes_branch_owner_path_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A folder with that slug already exists under this parent.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
