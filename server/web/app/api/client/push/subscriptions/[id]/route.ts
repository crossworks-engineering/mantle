import { gone } from '@/lib/gone';

/** Removed in workspaces W5c: the client portal is gone (and the client login with it, W8a). Answers 410 code gone to any login. */
export const DELETE = gone('any');
