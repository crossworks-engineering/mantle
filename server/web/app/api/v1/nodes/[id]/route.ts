import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/nodes/:id. */
export { GET } from '../../../nodes/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: null, aliasOf: 'GET /api/nodes/:id' },
});
