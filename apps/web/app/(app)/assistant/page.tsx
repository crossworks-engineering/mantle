import { cookies } from 'next/headers';
import { requireOwner } from '@/lib/auth';
import { listAssistantAgents, recentAssistantMessages, resolveAssistantAgent } from '@/lib/assistant';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { BoringAvatar } from '@/components/boring-avatar';
import { SetPageTitle } from '@/components/layout/page-title';
import { AssistantClient } from './assistant-client';
import { AgentSelect } from './agent-select';

const AGENT_COOKIE = 'mantle_assistant_agent';

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  // Persistence chain: explicit ?agent= URL param wins, else cookie from
  // the last selection, else resolveAssistantAgent's priority default.
  // AgentSelect writes the cookie at pick-time; this read is the SSR
  // counterpart so first paint shows the right thread without a flash.
  const cookieStore = await cookies();
  const slugHint = params.agent ?? cookieStore.get(AGENT_COOKIE)?.value;
  const [agentList, agent] = await Promise.all([
    listAssistantAgents(user.id),
    resolveAssistantAgent(user.id, slugHint),
  ]);

  // Per-agent thread: each agent owns its own forever-conversation. The
  // legacy fold-in (NULL agent_id → any assistant-role agent) was the
  // "different agents show the same chat with content swapped" bug; killed
  // by migration 0049 + the NOT NULL constraint on agent_id.
  const messages = agent ? await recentAssistantMessages(user.id, agent.id, 100) : [];

  const accent = agent ? agentAccent(agent.slug) : null;

  return (
    <div className="flex h-full flex-col">
      <SetPageTitle title={agent ? agent.name : 'Assistant'} />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          {agent && agent.avatar ? (
            <BoringAvatar
              variant={agent.avatar.style}
              seed={agent.avatar.seed}
              size={40}
              className="ring-2"
              style={{ '--tw-ring-color': accent?.border } as React.CSSProperties}
            />
          ) : (
            agent &&
            accent && (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ring-2"
                style={{ backgroundColor: accent.solid, '--tw-ring-color': accent.border } as React.CSSProperties}
                aria-hidden
              >
                {agentInitials(agent.name)}
              </span>
            )
          )}
          <div>
            <p className="text-xs text-muted-foreground">
              {agent ? (
                <>
                  <code className="font-mono">{agent.slug}</code> ·{' '}
                  <code className="font-mono">{agent.model}</code> — separate thread per agent, shared brain.
                </>
              ) : (
                <span className="text-destructive">
                  No enabled agent. Configure one at{' '}
                  <a href="/settings/agents" className="underline">
                    /settings/agents
                  </a>
                  .
                </span>
              )}
            </p>
          </div>
        </div>
        {agentList.length > 0 && <AgentSelect agents={agentList} selected={agent?.slug ?? ''} />}
      </header>

      <AssistantClient
        initialMessages={messages}
        agentReady={!!agent}
        agentSlug={agent?.slug}
        agentName={agent?.name}
        agentAvatar={agent?.avatar ?? null}
      />
    </div>
  );
}
