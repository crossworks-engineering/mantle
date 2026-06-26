import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAccountFolders, setIncludedFolders } from '@mantle/email';
import { requireOwner } from '@/lib/auth';

/** Live IMAP folder tree + current scan config for one account. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const result = await listAccountFolders(user.id, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

const FoldersBody = z.object({ folders: z.array(z.string()).default([]) });

/** Persist the explicit folder allow-list and kick an immediate rescan. An empty
 *  array clears the list back to "scan all non-excluded". */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const parsed = FoldersBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const ok = await setIncludedFolders(user.id, id, parsed.data.folders);
  if (!ok) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
