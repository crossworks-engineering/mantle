import { NextResponse } from 'next/server';
import { discoverForAccount, listAccounts, listDrives } from '@mantle/microsoft';
import type { MsDriveDTO } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

/** 404 unless the account belongs to the owner (`listDrives` isn't owner-scoped). */
async function assertOwned(ownerId: string, accountId: string): Promise<boolean> {
  const accounts = await listAccounts(ownerId);
  return accounts.some((a) => a.id === accountId);
}

/** Wire projection of an `MsDrive` row — drops the server-only Graph `deltaLink`
 *  cursor and `accountId`; `lastSyncAt` becomes an ISO string. The `MsDriveDTO`
 *  return type makes a drift between row and wire shape a compile error. */
function toDriveDTO(d: Awaited<ReturnType<typeof listDrives>>[number]): MsDriveDTO {
  return {
    id: d.id,
    driveId: d.driveId,
    driveType: d.driveType,
    name: d.name,
    siteName: d.siteName,
    webUrl: d.webUrl,
    enabled: d.enabled,
    lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
    lastError: d.lastError,
    scopeCount: d.scopeCount,
  };
}

/** Drives discovered for an account (OneDrive + followed SharePoint libraries). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!(await assertOwned(user.id, id))) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  }
  const drives = (await listDrives(id)).map(toDriveDTO);
  return NextResponse.json({ drives });
}

/** Re-enumerate the account's drives. Returns the refreshed list. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!(await assertOwned(user.id, id))) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  }
  await discoverForAccount(user.id, id);
  const drives = (await listDrives(id)).map(toDriveDTO);
  return NextResponse.json({ drives });
}
