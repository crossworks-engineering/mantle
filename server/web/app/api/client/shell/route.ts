import { gone } from '@/lib/gone';

/** Removed in workspaces W5c: every login reads GET /api/shell (the client login went in W8a). Answers 410 code gone to any login. */
export const GET = gone('any');
