import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/journal. */
export { GET, POST } from '../../journal/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'journal', aliasOf: 'GET /api/journal' },
  POST: {
    class: 'content',
    item: { none: 'names no item in its path' },
    keyArea: 'journal',
    aliasOf: 'POST /api/journal',
  },
});
