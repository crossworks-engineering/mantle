import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/pages. */
export { GET, POST } from '../../pages/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'pages', aliasOf: 'GET /api/pages' },
  POST: {
    class: 'content',
    item: { none: 'creates an item: ?ws= names where it lands' },
    keyArea: 'pages',
    aliasOf: 'POST /api/pages',
  },
});
