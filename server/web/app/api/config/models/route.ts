import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { computeModelCheck } from '@/lib/system-manifest/model-check-db';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** The model check: does this box run the shipped default model on each
 *  worker and manifest agent (read-only; lib/system-manifest/model-check.ts).
 *  Same report as the `config_models_check` MCP tool. */
export async function GET() {
  const user = ownerCaller();
  const report = await computeModelCheck(user.id);
  return NextResponse.json({ report });
}
