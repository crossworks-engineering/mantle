import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/contacts/:id. */
export { GET, routeParams } from '../../../contacts/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'contacts', aliasOf: 'GET /api/contacts/:id' },
});
