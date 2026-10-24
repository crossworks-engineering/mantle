import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/search. */
export { GET } from '../../search/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'search', aliasOf: 'GET /api/search' },
});
