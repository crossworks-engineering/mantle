/**
 * GET /api/team-admin/clients/storage (client logins C5 audit, I5): what the
 * client spaces hold against the client limits. The total for ALL client
 * spaces (MANTLE_CLIENT_SPACES_TOTAL_BYTES, 5 GB by default) and its use,
 * each client space's bytes (files, page and note text), uploads in the
 * last 24 hours, items and open submissions, a deleted client's space while
 * it waits for its purge (`former`: it still counts), and the quota
 * refusals of the last 7 days. The storage card in Team admin > Clients.
 * Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import {
  CLIENT_SPACE_LIMITS,
  clientSpacesTotalBytes,
  clientSpacesUsed,
  clientStorageRows,
  listClientQuotaRefusals,
} from '@mantle/content';
import type { ClientStorageUsage } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [totalUsedBytes, rows, refusals] = await Promise.all([
    clientSpacesUsed(),
    clientStorageRows(),
    listClientQuotaRefusals(50),
  ]);
  const lim = CLIENT_SPACE_LIMITS;
  const body: ClientStorageUsage = {
    limits: {
      fileMaxBytes: lim.fileMaxBytes,
      perClientBytes: lim.storageBytes,
      dailyUploadBytes: lim.dailyUploadBytes,
      itemLimit: lim.itemLimit,
      totalBytes: clientSpacesTotalBytes(),
      submitsPerDay: lim.submitsPerDay ?? 0,
      openSubmissions: lim.openSubmissions ?? 0,
    },
    totalUsedBytes,
    rows,
    refusals,
  };
  return NextResponse.json(body);
}
