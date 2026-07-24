'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistantDock } from '@/components/assistant/assistant-dock';

/**
 * The assistant is no longer a screen you go to — it's a global content-area
 * overlay summoned by the bubble / ⌘I (see <AssistantPanel/>). This route is
 * kept only so existing links + deep links (`/assistant?agent=<slug>`) still
 * work: it opens the overlay on the requested agent, then bounces to the
 * dashboard so minimising the panel reveals a real screen behind it.
 *
 * Auth: server-origin 401s (zero-secret client — see the (app) layout).
 */
export default function AssistantPage() {
  const router = useRouter();
  const { openAssistant } = useAssistantDock();

  useEffect(() => {
    const agent = new URLSearchParams(window.location.search).get('agent') ?? undefined;
    openAssistant(agent);
    router.replace('/');
  }, [openAssistant, router]);

  return null;
}
