'use client';

/**
 * Agent picker for the in-surface "Assist" panels (/pages, /tables, /dev-tools).
 *
 * The configurability the operator asked for lives HERE, on the surface itself:
 * a compact dropdown in the Assist panel header that chooses which agent the
 * panel delegates to. It persists to profiles.preferences via
 * POST /api/profile/assist-agent and falls back to the surface's default
 * specialist (Pages / Ledger) when left on "Default".
 *
 * Self-contained: loads the agent list (GET /api/agents) and the current
 * selection (GET /api/profile/assist-agent) on mount, so neither editor's
 * server component needs to thread preferences down.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';

type AgentOption = { slug: string; name: string };

// Sentinel for "use the surface default" — Radix Select can't hold an empty
// string value, so we map this to/from null at the API boundary.
const DEFAULT_VALUE = '__default__';

export function AssistAgentPicker({
  surface,
  /** Label shown for the default option, e.g. "Pages (default)". */
  defaultLabel,
  /** Notified with the resolved display name after a successful change, so the
   *  panel can update its "X is working…" labels. Optional. */
  onAgentNameChange,
}: {
  surface: 'pages' | 'tables' | 'dev-tools';
  defaultLabel: string;
  onAgentNameChange?: (name: string | null) => void;
}) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [value, setValue] = useState<string>(DEFAULT_VALUE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [agentsJson, prefJson] = await Promise.all([
          apiFetch<{ agents?: { slug: string; name: string }[] }>('/api/agents'),
          apiFetch<{
            pages?: string | null;
            tables?: string | null;
            'dev-tools'?: string | null;
          }>('/api/profile/assist-agent'),
        ]);
        if (cancelled) return;
        setAgents((agentsJson.agents ?? []).map((a) => ({ slug: a.slug, name: a.name })));
        const current =
          surface === 'pages'
            ? prefJson.pages
            : surface === 'tables'
              ? prefJson.tables
              : prefJson['dev-tools'];
        setValue(current || DEFAULT_VALUE);
      } catch {
        // best-effort; the default option stands
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [surface]);

  const onChange = useCallback(
    async (next: string) => {
      const prev = value;
      setValue(next);
      setSaving(true);
      try {
        await apiSend('/api/profile/assist-agent', 'POST', {
          surface,
          agentSlug: next === DEFAULT_VALUE ? null : next,
        });
        const name =
          next === DEFAULT_VALUE ? null : (agents.find((a) => a.slug === next)?.name ?? null);
        onAgentNameChange?.(name);
      } catch (e) {
        setValue(prev);
        if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
        toast.error('Could not change the assist agent');
      } finally {
        setSaving(false);
      }
    },
    [value, surface, agents, toast, onAgentNameChange],
  );

  return (
    <Select value={value} onValueChange={(v) => void onChange(v)} disabled={!loaded || saving}>
      <SelectTrigger
        className="h-7 w-auto gap-1 border-none bg-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
        aria-label="Choose which agent handles Assist"
        title="Which agent handles Assist on this surface"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem>
        {agents.map((a) => (
          <SelectItem key={a.slug} value={a.slug}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
