import { gone } from '@/lib/gone';

/** Removed in workspaces W5c: every login reads GET /api/shell. Answers 410 code gone to a member login. */
export const GET = gone('member');
