import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tables. */
export { GET } from '../../tables/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'tables', aliasOf: 'GET /api/tables' },
});
