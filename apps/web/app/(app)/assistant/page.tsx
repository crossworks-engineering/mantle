import { requireOwner } from '@/lib/auth';
import { listAssistantAgents, recentAssistantMessages, resolveAssistantAgent } from '@/lib/assistant';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { avatarUrl } from '@/lib/avatar';
import { AssistantClient } from './assistant-client';
import { AgentSelect } from './agent-select';

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const [agentList, agent] = await Promise.all([
    listAssistantAgents(user.id),
    resolveAssistantAgent(user.id, params.agent),
  ]);

  // Per-agent thread: legacy (pre-agentId) rows fold into the default
  // assistant/responder; a custom agent (e.g. coder) gets a clean thread.
  const includeLegacy = agent ? agent.role === 'assistant' || agent.role === 'responder' : true;
  const messages = agent
    ? await recentAssistantMessages(user.id, 100, { agentId: agent.id, includeLegacy })
    : [];

  const accent = agent ? agentAccent(agent.slug) : null;
  const agentAvatarUri = agent?.avatar ? avatarUrl(agent.avatar.style, agent.avatar.seed) : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          {agent && agentAvatarUri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agentAvatarUri}
              alt=""
              className="size-10 shrink-0 rounded-full ring-2"
              style={{ '--tw-ring-color': accent?.border } as React.CSSProperties}
              aria-hidden
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
            <h1 className="font-logo text-3xl font-normal leading-none lowercase text-foreground">
              {agent ? agent.name : 'Assistant'}
            </h1>
            <p className="text-xs text-muted-foreground">
              {agent ? (
                <>
                  <code className="font-mono">{agent.slug}</code> ·{' '}
                  <code className="font-mono">{agent.model}</code> — each agent keeps its own thread.
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
        agentAvatar={agentAvatarUri}
      />
    </div>
  );
}
