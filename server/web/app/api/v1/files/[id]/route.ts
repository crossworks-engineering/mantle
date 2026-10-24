import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/files/files/:id. */
export { GET, routeParams } from '../../../files/files/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'files', aliasOf: 'GET /api/files/files/:id' },
});
