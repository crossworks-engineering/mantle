import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/notes. */
export { GET, POST } from '../../notes/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes' },
  POST: {
    class: 'content',
    item: { none: 'creates an item: ?ws= names where it lands' },
    keyArea: 'notes',
    aliasOf: 'POST /api/notes',
  },
});
