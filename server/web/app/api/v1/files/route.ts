import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/files/files. */
export { GET, POST } from '../../files/files/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'files', aliasOf: 'GET /api/files/files' },
  POST: {
    class: 'content',
    item: { none: 'creates an item: ?ws= names where it lands' },
    keyArea: 'files',
    aliasOf: 'POST /api/files/files',
  },
});
