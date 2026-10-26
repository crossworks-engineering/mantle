import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tasks/:id. */
export { GET, PATCH, routeParams } from '../../../tasks/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'tasks', aliasOf: 'GET /api/tasks/:id' },
  PATCH: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
    keyArea: 'tasks',
    aliasOf: 'PATCH /api/tasks/:id',
  },
});
