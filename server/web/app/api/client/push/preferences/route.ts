import { gone } from '@/lib/gone';

/** Removed in workspaces W5c: the client portal is gone (a client uses the one app shell). Answers 410 code gone to a client login. */
export const GET = gone('client');
export const PUT = gone('client');
