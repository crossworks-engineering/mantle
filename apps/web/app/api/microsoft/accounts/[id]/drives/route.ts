import { NextResponse } from 'next/server';
import { discoverForAccount, listAccounts, listDrives } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';

/** 404 unless the account belongs to the owner (`listDrives` isn't owner-scoped). */
async function assertOwned(ownerId: string, accountId: string): Promise<boolean> {
  const accounts = await listAccounts(ownerId);
  return accounts.some((a) => a.id === accountId);
}

/** Drives discovered for an account (OneDrive + followed SharePoint libraries). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  if (!(await assertOwned(user.id, id))) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  }
  const drives = await listDrives(id);
  return NextResponse.json({ drives });
}

/** Re-enumerate the account's drives. Returns the refreshed list. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  if (!(await assertOwned(user.id, id))) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  }
  await discoverForAccount(user.id, id);
  const drives = await listDrives(id);
  return NextResponse.json({ drives });
}
