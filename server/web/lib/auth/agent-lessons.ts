/**
 * The lessons in the window's own requests (docs/agent-ui.md, "Lesson
 * trust"): a tagged write to a page of the Admin workspace's Lessons folder
 * (@mantle/tools/lessons) is refused `publish`: a lesson is code that runs
 * in members' windows, and people edit lessons. Every server-side page tool
 * of an agent turn meets the same rule in the tool loop.
 */
import { lessonItemIn } from '@mantle/tools/lessons';
import { brainId } from './agent-embeds';

/** The page routes an agent may write through (agent-call.allowed.ts) that
 *  write an existing page named by its `:id`. A create lands in a folder
 *  named by a move field (refused already); a commit and a discard are
 *  refused for every page. */
export const LESSON_ROUTES: ReadonlySet<string> = new Set([
  'PATCH /api/pages/:id',
  'PATCH /api/v1/pages/:id',
  'PUT /api/pages/:id/draft',
]);

/** Whether a page is a lesson: asked of the database, injectable for
 *  tests. */
export type LessonCheck = (pageId: string) => Promise<boolean>;

/** The default check, in the request's scope. */
export const isLessonPage: LessonCheck = async (pageId) => {
  // An id that is no uuid names no page (the route answers it 404).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    return false;
  }
  const owner = await brainId();
  // No brain to ask: held, never let through.
  return owner === null ? true : lessonItemIn(owner, [pageId]);
};
