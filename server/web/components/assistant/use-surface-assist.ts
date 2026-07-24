'use client';

import { useEffect, useRef } from 'react';
import {
  useAssistantDock,
  type ContextKind,
  type SurfaceSelection,
} from '@/components/assistant/assistant-dock';

/**
 * Wire a content screen (Pages / Tables / App Builder) to the global assistant
 * overlay so the always-on chat *is* the screen's assistant — no per-screen chat
 * panel, and no agent switching: the user's selected responder stays in charge
 * everywhere and delegates to the surface specialists (Pages / Ledger /
 * Appsmith) herself via invoke_agent. While the screen is mounted this hook:
 *
 *   1. pins the open node as context so it rides every turn (the responder
 *      always knows what you're editing, and which specialist to hand it to);
 *   2. folds an optional focus directive (Pages gutter marks, the Apps inspect
 *      region) into the sent text;
 *   3. publishes the in-node selection (marked blocks with snippets) so the
 *      composer shows it as chips — the user SEES what the assistant sees;
 *   4. publishes the pending draft-change count for the panel's context strip;
 *   5. refreshes the screen's editor when a turn that edited this node settles —
 *      preserving the draft-review flow (edits land in a draft; you Commit in the
 *      editor) the old panels provided.
 *
 * All of it is torn down on unmount, so leaving the screen drops the pinned
 * node, selection, and change count.
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
  /** The in-node selection behind the focus directive, with human-readable
   *  labels — shown as composer chips. Memoise it (a fresh object every render
   *  re-publishes every render). Null/omitted when the surface has none. */
  selection?: SurfaceSelection | null;
  /** Draft changes pending review on this node (Pages review count). */
  changeCount?: number | null;
  /** Called when a turn that edited this node completes — refresh the editor. */
  onEdited?: () => void;
  /** Set false to disable the wiring (e.g. an embedded preview). Default true. */
  enabled?: boolean;
}): { busy: boolean } {
  const {
    node,
    focusDirective = null,
    selection = null,
    changeCount = null,
    onEdited,
    enabled = true,
  } = opts;
  const {
    setPinnedContext,
    setExtraDirective,
    setSurfaceSelection,
    setSurfaceChanges,
    registerTurnListener,
    busy,
    activeContextNodeId,
  } = useAssistantDock();

  const nodeId = node?.id;
  const nodeKind = node?.kind;
  const nodeLabel = node?.label;

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

  // Publish the selection + pending-change count for the composer chips and
  // the panel's context strip; clear on leave / change.
  useEffect(() => {
    if (!enabled) return;
    setSurfaceSelection(selection && selection.items.length > 0 ? selection : null);
    return () => setSurfaceSelection(null);
  }, [enabled, selection, setSurfaceSelection]);
  useEffect(() => {
    if (!enabled) return;
    setSurfaceChanges(changeCount ?? null);
    return () => setSurfaceChanges(null);
  }, [enabled, changeCount, setSurfaceChanges]);

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
