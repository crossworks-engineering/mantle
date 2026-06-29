'use client';

import { useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useAssistantDock, type ContextKind } from '@/components/assistant/assistant-dock';

/**
 * Wire a content screen (Pages / Tables / App Builder) to the global assistant
 * overlay so the always-on chat *is* the screen's assistant — no per-screen chat
 * panel. While the screen is mounted this hook:
 *
 *   1. resolves + arms the surface's specialist (Pages / Ledger / Appsmith) as
 *      the overlay's active agent, without touching the user's sticky pick;
 *   2. pins the open node as context so it rides every turn (the specialist
 *      always knows what you're editing);
 *   3. folds an optional focus directive (Pages gutter marks, the Apps inspect
 *      region) into the sent text;
 *   4. refreshes the screen's editor when a turn that edited this node settles —
 *      preserving the draft-review flow (edits land in a draft; you Commit in the
 *      editor) the old panels provided.
 *
 * All of it is torn down on unmount, so leaving the screen reverts the overlay to
 * the user's sticky agent and drops the pinned node.
 *
 * `busy` is true only while a turn editing THIS node is in flight — a screen uses
 * it to lock its editor against the race where typing lands in the draft the
 * specialist is mid-edit on.
 */
export function useSurfaceAssist(opts: {
  surface: 'pages' | 'tables' | 'apps';
  /** The open node (null while it's still loading — the hook no-ops until set). */
  node: { id: string; kind: ContextKind; label: string } | null;
  /** Focus directive to fold into the sent text, or null when nothing's focused. */
  focusDirective?: string | null;
  /** Called when a turn that edited this node completes — refresh the editor. */
  onEdited?: () => void;
  /** Set false to disable the wiring (e.g. an embedded preview). Default true. */
  enabled?: boolean;
}): { busy: boolean } {
  const { surface, node, focusDirective = null, onEdited, enabled = true } = opts;
  const {
    setRouteAgent,
    setPinnedContext,
    setExtraDirective,
    registerTurnListener,
    busy,
    activeContextNodeId,
  } = useAssistantDock();

  const nodeId = node?.id;
  const nodeKind = node?.kind;
  const nodeLabel = node?.label;

  // Resolve + arm the surface specialist; revert to the sticky agent on leave.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<{ agentSlug: string | null }>(`/api/assist/agent?surface=${surface}`)
      .then((d) => {
        if (!cancelled && d.agentSlug) setRouteAgent(d.agentSlug);
      })
      .catch(() => {
        /* no specialist provisioned — leave the sticky agent in place */
      });
    return () => {
      cancelled = true;
      setRouteAgent(undefined);
    };
  }, [enabled, surface, setRouteAgent]);

  // Pin the open node so it rides every turn; drop it on leave / node change.
  useEffect(() => {
    if (!enabled || !nodeId || !nodeKind) return;
    setPinnedContext([{ id: nodeId, kind: nodeKind, label: nodeLabel ?? nodeId }]);
    return () => setPinnedContext([]);
  }, [enabled, nodeId, nodeKind, nodeLabel, setPinnedContext]);

  // Fold the focus directive into the sent text; clear on leave / change.
  useEffect(() => {
    if (!enabled) return;
    setExtraDirective(focusDirective);
    return () => setExtraDirective(null);
  }, [enabled, focusDirective, setExtraDirective]);

  // Refresh the editor when a turn editing this node completes. Keep `onEdited`
  // in a ref so an inline callback doesn't re-subscribe every render.
  const onEditedRef = useRef(onEdited);
  onEditedRef.current = onEdited;
  useEffect(() => {
    if (!enabled || !nodeId) return;
    return registerTurnListener((detail) => {
      if (detail.status === 'done' && detail.nodeId === nodeId) onEditedRef.current?.();
    });
  }, [enabled, nodeId, registerTurnListener]);

  const busyHere = enabled && busy && !!nodeId && activeContextNodeId === nodeId;
  return { busy: busyHere };
}
