import { cookies } from 'next/headers';
import { requireOwner } from '@/lib/auth';
import { AssistantThreadClient } from './assistant-thread-client';

const AGENT_COOKIE = 'mantle_assistant_agent';

/**
 * Assistant — per-agent forever-conversation. Data-free: the page only resolves
 * the agent *hint* (explicit ?agent= URL param wins, else the cookie from the
 * last pick — neither is a DB read), then AssistantThreadClient fetches the
 * agent list + resolved agent + initial thread from GET /api/assistant/thread.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const cookieStore = await cookies();
  const slugHint = params.agent ?? cookieStore.get(AGENT_COOKIE)?.value;

  return <AssistantThreadClient slugHint={slugHint} />;
}
