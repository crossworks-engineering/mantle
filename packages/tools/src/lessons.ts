/**
 * The lessons (docs/agent-ui.md, "Lesson trust"): the pages of the
 * top-level "Lessons" folder of the pages tree homed in the Admin
 * workspace. A lesson is code that runs in members' windows, so no agent
 * writes one: the window's tagged requests (server/web lib/auth/agent-call.ts,
 * reason `publish`) and every page, draft or tree tool on an agent turn
 * (runtime tool-loop execute-call.ts) are refused there, and people edit
 * lessons. The folder is found by its title, so an agent renames no folder
 * to or from "Lessons" and moves nothing into or out of it either (the move
 * names the folder or an item inside it). Its own entry point
 * (`@mantle/tools/lessons`), so a test that stands the package's index in
 * still reads the real rule.
 */
import { sql } from 'drizzle-orm';
import { db, itemHomeSql } from '@mantle/db';
import { isUuid } from '@mantle/std';

/** The refusal an agent's page tool answers on a lesson. */
export const LESSON_REFUSAL =
  'lesson_page: this page is a lesson (the Lessons folder in the Admin workspace), and lessons are edited by people, not by an assistant. Tell the person what to change.';

/** The refusal of an agent's rename to "Lessons" (any case, trimmed). */
export const LESSON_NAME_REFUSAL =
  'lesson_page: "Lessons" is the name of the lessons folder (the Admin workspace), and only people name a folder so. Choose another name, or tell the person.';

/** The refusal of an agent's call naming an id that is no uuid. */
export const LESSON_BAD_ID_REFUSAL =
  'bad_arguments: an item id of this call is not an id (a uuid). Pass the id as the list or search answered it.';

/** Whether a folder name is the lessons folder's: "Lessons", any case,
 *  trimmed (the folder lookup below reads its title the same way). */
export function isLessonsName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'lessons';
}

/**
 * The ids a call names, read as the handlers read them: each string
 * trimmed (and lower-cased, as Postgres reads a uuid), a list's strings
 * each; a missing value, a non-string or '' (the handlers' "not given")
 * names nothing. `bad` is what is no uuid after that: a call naming one is
 * refused, never checked as if it named nothing.
 */
export function namedItemIds(values: readonly unknown[]): { ids: string[]; bad: number } {
  const ids: string[] = [];
  let bad = 0;
  for (const v of values.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    if (typeof v !== 'string') continue;
    const id = v.trim().toLowerCase();
    if (id === '') continue;
    if (isUuid(id)) ids.push(id);
    else bad += 1;
  }
  return { ids, bad };
}

/** The args of an agent's page or tree write that name an item or folder:
 *  the tool's own item args and the names those tools use. */
const ITEM_PARAMS = ['id', 'page_id', 'folder_id', 'parent_id', 'item_id', 'item_ids', 'after'];

/**
 * Why an agent turn's page, draft or tree write is refused for the
 * lessons, or null: an id that is no uuid; a rename or a new folder named
 * "Lessons" in the pages tree; any id it names is the Lessons folder or
 * inside it (a write, a rename away, a move in or out, a delete). Null for
 * a read and for another tool. `itemParams` are the tool's declared item
 * args; `inLessons` asks the folder (lessonItemIn, which the caller passes
 * so a test standing it in reaches this rule).
 */
export async function lessonCallRefusal(
  ownerId: string,
  slug: string,
  input: Record<string, unknown>,
  itemParams: readonly string[],
  inLessons: (ownerId: string, ids: readonly string[]) => Promise<boolean>,
): Promise<string | null> {
  if (!slug.startsWith('page_') && !slug.startsWith('tree_')) return null;
  const { ids, bad } = namedItemIds(
    [...new Set([...itemParams, ...ITEM_PARAMS])].map((p) => input[p]),
  );
  if (bad > 0) return LESSON_BAD_ID_REFUSAL;
  if (
    (slug === 'tree_folder_update' || slug === 'tree_folder_create') &&
    input.kind === 'pages' &&
    isLessonsName(input.name)
  ) {
    return LESSON_NAME_REFUSAL;
  }
  return ids.length > 0 && (await inLessons(ownerId, ids)) ? LESSON_REFUSAL : null;
}

/**
 * Whether any of `ids` is the Lessons folder or an item inside it: the
 * top-level pages folder titled "Lessons" (any case, trimmed) homed in the
 * Admin workspace. The ids are read as the handlers read them
 * (namedItemIds); one that is no uuid after that answers true, refused
 * rather than taken for nothing. Read in the caller's scope: a scope that
 * does not read the Admin workspace writes nothing there anyway.
 */
export async function lessonItemIn(ownerId: string, ids: readonly unknown[]): Promise<boolean> {
  const { ids: list, bad } = namedItemIds(ids);
  if (bad > 0) return true;
  if (list.length === 0) return false;
  const rows = (await db.execute(sql`
    select exists (
      select 1 from nodes f
        join nodes n on n.owner_id = f.owner_id and n.path <@ f.path
       where f.owner_id = ${ownerId}::uuid and f.type = 'branch'
         and nlevel(f.path) = 2 and subpath(f.path, 0, 1) = 'pages'::ltree
         and lower(btrim(f.title)) = 'lessons'
         and ${itemHomeSql('f')} = mantle_ws_admin_id(${ownerId}::uuid)
         and n.id = any(${`{${list.join(',')}}`}::uuid[])
    ) as hit`)) as unknown as { hit: boolean }[];
  return rows[0]?.hit === true;
}
