import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tasks/:id. */
export { GET, PATCH, routeParams } from '../../../tasks/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'tasks', aliasOf: 'GET /api/tasks/:id' },
  PATCH: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
    keyArea: 'tasks',
    aliasOf: 'PATCH /api/tasks/:id',
  },
});
