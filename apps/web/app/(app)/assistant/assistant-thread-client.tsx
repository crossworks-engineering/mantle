'use client';

import { useQuery } from '@tanstack/react-query';
import { GitCompareArrows, Highlighter, MapPin, Maximize2, Minus, PanelRight } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { BoringAvatar } from '@/components/boring-avatar';
import { useAssistantDock } from '@/components/assistant/assistant-dock';
import { AssistantClient } from './assistant-client';
import { AgentSelect } from './agent-select';
import type { AssistantAgentOption, AssistantTimelineRow } from '@/lib/assistant';

/** The fields the header + chat need off the resolved agent. */
type ResolvedAgent = {
  id: string;
  slug: string;
  name: string;
  model: string;
  avatar: { style: string; seed: string } | null;
};

type ThreadData = {
  agents: AssistantAgentOption[];
  agent: ResolvedAgent | null;
  messages: AssistantTimelineRow[];
};

/**
 * Data-free /assistant. Fetches the agent list + resolved agent + initial
 * thread from GET /api/assistant/thread (keyed on the ?agent slug hint the page
 * reads from the URL/cookie), then renders the header + chat. AgentSelect still
 * writes the cookie + navigates to ?agent=<slug>, which re-keys this query.
 */
export function AssistantThreadClient({ slugHint }: { slugHint?: string }) {
  const { minimize, docked, toggleDocked, pinnedContext, surfaceSelection, surfaceChanges } =
    useAssistantDock();
  const threadQuery = useQuery({
    queryKey: ['assistant', 'thread', slugHint ?? ''],
    queryFn: () =>
      apiFetch<ThreadData>(
        slugHint
          ? `/api/assistant/thread?agent=${encodeURIComponent(slugHint)}`
          : '/api/assistant/thread',
      ),
  });

  if (threadQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (threadQuery.isError && !threadQuery.data) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
        Couldn&apos;t load the assistant.
      </div>
    );
  }

  const { agents: agentList, agent, messages } = threadQuery.data;
  const accent = agent ? agentAccent(agent.slug) : null;

  return (
    <div className="flex h-full flex-col">
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
        <div className="flex items-center gap-1.5">
          {agentList.length > 0 && <AgentSelect agents={agentList} selected={agent?.slug ?? ''} />}
          {/* Column ⇄ full display, on every screen (lg+; below lg the panel is
              always the full overlay). The third mode — minimised to the
              bubble — is the button beside this one. */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden size-8 lg:inline-flex"
            onClick={toggleDocked}
            title={docked ? 'Expand to full display' : 'Shrink to a side column'}
            aria-label={docked ? 'Expand assistant to full display' : 'Shrink assistant to a side column'}
          >
            {docked ? <Maximize2 aria-hidden /> : <PanelRight aria-hidden />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={minimize}
            title="Minimise (Esc)"
            aria-label="Minimise assistant"
          >
            <Minus aria-hidden />
          </Button>
        </div>
      </header>

      {/* Context strip — one line of truth about what the assistant is working
          with: the pinned on-screen node, how many sections are focused, and
          how many draft changes await review. Only when a surface is pinned. */}
      {pinnedContext.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-6 py-1.5 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="truncate">
              Working on <span className="font-medium text-foreground">{pinnedContext[0]?.label}</span>
            </span>
          </span>
          {surfaceSelection && surfaceSelection.items.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Highlighter className="size-3.5 shrink-0 text-primary" aria-hidden />
              {surfaceSelection.items.length} {surfaceSelection.noun}
              {surfaceSelection.items.length === 1 ? '' : 's'} focused
            </span>
          )}
          {surfaceChanges != null && surfaceChanges > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <GitCompareArrows className="size-3.5 shrink-0" aria-hidden />
              {surfaceChanges} draft change{surfaceChanges === 1 ? '' : 's'} to review
            </span>
          )}
        </div>
      )}

      <AssistantClient
        // Force a remount on agent change so the draft input, attachment,
        // recording state, and optimistic messages don't carry across agents.
        // The SSR-equivalent initialMessages are already per-agent; the key
        // makes React honour the swap.
        key={agent?.slug ?? '__none__'}
        initialMessages={messages}
        agentReady={!!agent}
        agentSlug={agent?.slug}
        agentName={agent?.name}
        agentAvatar={agent?.avatar ?? null}
      />
    </div>
  );
}
