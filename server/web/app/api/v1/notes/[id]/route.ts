import { routePolicy } from '@/lib/auth/route-declaration';
/** Public API v1 (lib/api-v1.ts): the same handler as /api/notes/:id. */
export { GET, routeParams } from '../../../notes/[id]/route';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes/:id' },
});
