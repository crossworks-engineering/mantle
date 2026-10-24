import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tables/:id. */
export { GET, routeParams } from '../../../tables/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'tables', aliasOf: 'GET /api/tables/:id' },
});
