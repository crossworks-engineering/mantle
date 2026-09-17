/** Zod pieces shared by the two /api/tasks routes (create + patch) — one
 *  definition so POST and PATCH can never drift on what a checklist item is. */
import { z } from 'zod';
import { TASK_TODOS_MAX, TASK_TODO_TEXT_MAX } from '@/lib/tasks';

export const TodoInputSchema = z.object({
  id: z.string().max(64).optional(),
  text: z.string().min(1).max(TASK_TODO_TEXT_MAX),
  done: z.boolean().optional(),
});

export const TodosSchema = z.array(TodoInputSchema).max(TASK_TODOS_MAX);

/** Route-param guard: a malformed id is a 404-shaped input, not a Postgres
 *  `invalid input syntax for type uuid` 500. */
export { isUuid } from '@mantle/std';
