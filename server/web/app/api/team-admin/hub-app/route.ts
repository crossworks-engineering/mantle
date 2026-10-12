/**
 * The brain-wide member home app (PUT designates, DELETE clears), removed
 * with per-workspace landing pages (task d78e7bde): each workspace sets its
 * own home app on its screen (PATCH /api/workspaces/:id `landingAppId`, a
 * Moderator of that workspace). Migration 0276 made the old designation the
 * Team workspace's home app. The stub keeps the old guard and answers 410.
 */
import { gone } from '@/lib/gone';

const MOVED =
  'The member home app moved: each workspace sets its landing page on its own screen. Update the app.';

export const PUT = gone('owner', MOVED);
export const DELETE = gone('owner', MOVED);
