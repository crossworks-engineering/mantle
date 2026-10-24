import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/contacts. */
export { GET } from '../../contacts/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'contacts', aliasOf: 'GET /api/contacts' },
});
