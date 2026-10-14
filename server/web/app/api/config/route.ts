import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { computeConfigDiff } from '@/lib/system-manifest/config-diff-db';

/** Config sanity report — the brain's live agent/skill/tool-group/worker config
 *  diffed against the shipped manifest template (read-only). Drives
 *  /settings/config; mutations go through /api/config/adopt(-all). */
export async function GET() {
  const user = ownerCaller();
  const report = await computeConfigDiff(user.id);
  return NextResponse.json({ report });
}
