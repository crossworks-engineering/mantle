import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { loadComboContext } from '@/lib/model-combos-context';
import { COMBO_DEFS, buildComboDiff } from '@/lib/model-combos';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

export async function GET() {
  const user = ownerCaller();
  const ctx = await loadComboContext(user.id);
  const combos = COMBO_DEFS.map((def) => {
    const targets = buildComboDiff(def.key, ctx.entries, ctx.targets, ctx.keyIdByService);
    return {
      ...def,
      targets,
      changed: targets.filter((t) => t.changed).length,
      blocked: targets.filter((t) => t.reason).length,
    };
  });
  return NextResponse.json({ combos });
}
