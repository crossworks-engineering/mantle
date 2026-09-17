import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { loadComboContext } from '@/lib/model-combos-context';
import { COMBO_DEFS, buildComboDiff } from '@/lib/model-combos';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
