import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/events. */
export { GET, POST } from '../../events/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'calendar', aliasOf: 'GET /api/events' },
  POST: {
    class: 'content',
    item: { none: 'creates an item: ?ws= names where it lands' },
    keyArea: 'calendar',
    aliasOf: 'POST /api/events',
  },
});
