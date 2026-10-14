import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { listAccountFolders, setIncludedFolders } from '@mantle/email';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';

/** Live IMAP folder tree + current scan config for one account. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const result = await listAccountFolders(user.id, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

const FoldersBody = z.object({ folders: z.array(z.string()).default([]) });

/** Persist the explicit folder allow-list and kick an immediate rescan. An empty
 *  array clears the list back to "scan all non-excluded". */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const body = await readBody(req, FoldersBody);
  const ok = await setIncludedFolders(user.id, id, body.folders);
  if (!ok) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
