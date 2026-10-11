/**
 * GET /api/team-admin/member-chats
 *
 * Gone (workspaces W7c, the owner's answer of 2026-10-11): Admin users no
 * longer read other users' chats. Each user reads only their own threads,
 * through /api/assistant/*. The owner's guard runs first (401 without a
 * session, a member or a client refused as before), then 410
 * `{ error, code: 'gone' }`.
 */
import { gone } from '@/lib/gone';

export const GET = gone(
  'owner',
  "Each user's chats are private to that user: admins no longer read other users' chats.",
);
