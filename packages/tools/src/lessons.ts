/**
 * The lessons (docs/agent-ui.md, "Lesson trust"): the pages of the
 * top-level "Lessons" folder of the pages tree homed in the Admin
 * workspace. A lesson is code that runs in members' windows, so no agent
 * writes one: the window's tagged requests (server/web lib/auth/agent-call.ts,
 * reason `publish`) and every page or draft tool on an agent turn
 * (runtime tool-loop execute-call.ts) are refused there, and people edit
 * lessons. Its own entry point (`@mantle/tools/lessons`), so a test that
 * stands the package's index in still reads the real rule.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

/** The refusal an agent's page tool answers on a lesson. */
export const LESSON_REFUSAL =
  'lesson_page: this page is a lesson (the Lessons folder in the Admin workspace), and lessons are edited by people, not by an assistant. Tell the person what to change.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether any of `ids` is the Lessons folder or an item inside it: the
 * top-level pages folder titled "Lessons" (any case) homed in the Admin
 * workspace. Read in the caller's scope: a scope that does not read the
 * Admin workspace writes nothing there anyway.
 */
export async function lessonItemIn(ownerId: string, ids: readonly unknown[]): Promise<boolean> {
  const list = ids.filter((v): v is string => typeof v === 'string' && UUID.test(v));
  if (list.length === 0) return false;
  const rows = (await db.execute(sql`
    select exists (
      select 1 from nodes f
        join nodes n on n.owner_id = f.owner_id and n.path <@ f.path
       where f.owner_id = ${ownerId}::uuid and f.type = 'branch'
         and nlevel(f.path) = 2 and subpath(f.path, 0, 1) = 'pages'::ltree
         and lower(f.title) = 'lessons'
         and f.home_ws = mantle_ws_admin_id(${ownerId}::uuid)
         and n.id = any(${`{${list.join(',')}}`}::uuid[])
    ) as hit`)) as unknown as { hit: boolean }[];
  return rows[0]?.hit === true;
}
