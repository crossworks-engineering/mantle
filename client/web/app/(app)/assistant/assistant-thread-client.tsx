'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitCompareArrows, Highlighter, MapPin, Minus } from 'lucide-react';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { agentAccent } from '@/lib/agent-color';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { Button } from '@mantle/web-ui/ui/button';
import { GeneratedAvatar } from '@mantle/web-ui/generated-avatar';
import { AreaBackdrop } from '@mantle/web-ui/area-backdrop';
import { useAssistantDock } from '@/components/assistant/assistant-dock';
import { ActiveRunsStrip } from '@/components/runs/active-runs-strip';
import { PendingQuestionsStrip } from '@/components/pending/pending-questions-strip';
import { AssistantClient } from './assistant-client';
import { AgentSelect } from './agent-select';
import type { AssistantAgentOption, AssistantTimelineRow } from '@server/lib/assistant';

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
  /** This login's own assistant, when the operator gave it one (migration 0143).
   *  Null when it shares the brain default. */
  assigned: { slug: string; assignedAt: string | null } | null;
};

/** Watermark for the last assignment this browser has already honoured. */
const ASSIGNED_SEEN_KEY = 'mantle_assistant_assigned_seen';

/**
 * Data-free /assistant. Fetches the agent list + resolved agent + initial
 * thread from GET /api/assistant/thread (keyed on the ?agent slug hint the page
 * reads from the URL/cookie), then renders the header + chat. AgentSelect still
 * writes the cookie + navigates to ?agent=<slug>, which re-keys this query.
 */
export function AssistantThreadClient({ slugHint }: { slugHint?: string }) {
  const { minimize, pinnedContext, surfaceSelection, surfaceChanges, setActiveAgentSlug } =
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

  // Adopt a NEW assignment once. The sticky `mantle_assistant_agent` cookie is
  // per-browser, so a co-admin who has been chatting to the shared agent keeps
  // landing there after the operator gives them their own — i.e. the change
  // wouldn't reach the very people it's for. Comparing the server's assignedAt
  // against a local watermark switches them over exactly once; a deliberate pick
  // from the agent picker afterwards is left alone.
  const assignedSlug = threadQuery.data?.assigned?.slug ?? null;
  const assignedAt = threadQuery.data?.assigned?.assignedAt ?? null;
  useEffect(() => {
    if (!assignedAt || !assignedSlug) return;
    if (window.localStorage.getItem(ASSIGNED_SEEN_KEY) === assignedAt) return;
    window.localStorage.setItem(ASSIGNED_SEEN_KEY, assignedAt);
    if (slugHint !== assignedSlug) setActiveAgentSlug(assignedSlug);
  }, [assignedAt, assignedSlug, slugHint, setActiveAgentSlug]);

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
    // `relative isolate` is what makes the backdrop below safe: unlike the
    // shell's panels this root is statically positioned, so without a stacking
    // context of its own a `-z-10` child would slip behind the page background
    // and vanish. `isolate` contains it.
    <div className="relative isolate flex h-full flex-col">
      {/* Renders nothing when the chat area is switched off. */}
      <AreaBackdrop area="chat" className="-z-10" />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          {/* No initials branch: the agent always has an avatar now — the seed
              falls back to its slug when no record is stored. */}
          {agent && (
            <GeneratedAvatar
              seed={agent.avatar?.seed || agent.slug}
              size={40}
              className="ring-2"
              containerStyle={{ '--tw-ring-color': accent?.border } as React.CSSProperties}
            />
          )}
          <div>
            <p className="text-xs text-muted-foreground">
              {agent ? (
                <>
                  <code className="font-mono">{agent.slug}</code> ·{' '}
                  <code className="font-mono">{agent.model}</code> — separate thread per agent,
                  shared brain.
                </>
              ) : (
                <span className="text-destructive-ink">
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
          {/* Full-display ⇄ side-column now lives in the footer toolbar
              (<AssistantDockToggle/>); minimise stays here. */}
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
            <MapPin className="size-3.5 shrink-0 text-primary-ink" aria-hidden />
            <span className="truncate">
              Working on{' '}
              <span className="font-medium text-foreground">{pinnedContext[0]?.label}</span>
            </span>
          </span>
          {surfaceSelection && surfaceSelection.items.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Highlighter className="size-3.5 shrink-0 text-primary-ink" aria-hidden />
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

      {/* Blocked runs first: a question is the only thing here the operator
          MUST act on — the run cannot advance without it. Self-hiding. */}
      <PendingQuestionsStrip />
      {/* Background runs the owner has in flight — compact cards, self-hiding
          when none are active (slice 4 WP-A). */}
      <ActiveRunsStrip />
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
