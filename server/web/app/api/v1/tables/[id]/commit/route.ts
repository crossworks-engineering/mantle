import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/tables/:id/commit. */
export { POST, routeParams } from '../../../../tables/[id]/commit/route';

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
    keyArea: 'tables',
    aliasOf: 'POST /api/tables/:id/commit',
  },
});
