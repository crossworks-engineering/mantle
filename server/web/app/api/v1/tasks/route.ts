import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tasks. */
export { GET, POST } from '../../tasks/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'tasks', aliasOf: 'GET /api/tasks' },
  POST: {
    class: 'content',
    item: { none: 'creates an item: ?ws= names where it lands' },
    keyArea: 'tasks',
    aliasOf: 'POST /api/tasks',
  },
});
