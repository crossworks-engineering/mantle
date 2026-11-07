/**
 * The lessons in the window's own requests (docs/agent-ui.md, "Lesson
 * trust"): a tagged write to a page of the Admin workspace's Lessons folder
 * (@mantle/tools/lessons), or to that folder itself (a rename away, a
 * restyle), is refused `publish`, and so is a tagged rename of any pages
 * folder to "Lessons" (the folder is found by its title): a lesson is code
 * that runs in members' windows, and people edit lessons. A move into or
 * out of it is refused already (a move field). Every server-side page,
 * draft or tree tool of an agent turn meets the same rule in the tool loop.
 */
import { isUuid } from '@mantle/std';
import { isLessonsName, lessonItemIn } from '@mantle/tools/lessons';
import { brainId } from './agent-embeds';

/** The routes an agent may write through (agent-call.allowed.ts) that
 *  write an existing page, or a tree folder, named by its `:id`. A create
 *  lands in a folder named by a move field (refused already); a commit and
 *  a discard are refused for every page. */
export const LESSON_ROUTES =
  /^(?:PATCH \/api\/(?:v1\/)?pages\/:id|PUT \/api\/pages\/:id\/draft|PATCH \/api\/tree\/:kind\/folders\/:id)$/;

/** The folder route whose `name` may not become "Lessons". */
export const FOLDER_RENAME_ROUTE = 'PATCH /api/tree/:kind/folders/:id';

/** Whether a tagged folder PATCH renames a pages folder to "Lessons" (any
 *  case, trimmed, as the route trims it). */
export function renamesToLessons(
  kind: string | null,
  body: Record<string, unknown> | null,
): boolean {
  return kind === 'pages' && body !== null && isLessonsName(body.name);
}

/** Whether a page (or a folder) is a lesson or the Lessons folder: asked
 *  of the database, injectable for tests. */
export type LessonCheck = (pageId: string) => Promise<boolean>;

/** The default check, in the request's scope. */
export const isLessonPage: LessonCheck = async (pageId) => {
  // An id that is no uuid names no page (the route answers it 404).
  if (!isUuid(pageId)) return false;
  const owner = await brainId();
  // No brain to ask: held, never let through.
  return owner === null ? true : lessonItemIn(owner, [pageId]);
};
