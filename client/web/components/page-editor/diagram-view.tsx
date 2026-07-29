'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Pencil, Check, TriangleAlert } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';

/** Hard cap on diagram source — beyond this we refuse to render (layout cost
 *  grows non-linearly on adversarial input) but always keep the source. */
const MAX_SOURCE_CHARS = 50_000;
/** A render that hasn't resolved by now is stuck — fail it, keep the last SVG. */
const RENDER_TIMEOUT_MS = 5_000;
/** Debounce between keystrokes in the source panel and a re-render/attr write. */
const DEBOUNCE_MS = 300;

// One mermaid module for every diagram on the page, loaded on first use so the
// ~1.5MB bundle stays out of the main chunk (self-hosted from node_modules —
// no CDN, matching the KaTeX precedent).
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  // On failure (offline dev, deploy skew 404ing the chunk) clear the cache so
  // the next render retries the import instead of replaying the rejection.
  mermaidPromise ??= import('mermaid')
    .then((m) => m.default)
    .catch((err: unknown) => {
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

/** Resolve a CSS custom property to its concrete value, with a fallback so a
 *  missing token never yields an empty color string (boring-avatar precedent). */
function token(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = cs.getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Map theme tokens into Mermaid `themeVariables`. Filled shapes sit on neutral
 * surfaces (`card`/`muted`) with `foreground` text — never chart tokens, which
 * are 3:1 data ink and not legible as text. `chart-1..5` color the categorical
 * series (pie slices, mindmap sections) where nothing has to be read on top.
 * Values must be concrete (mermaid does color math on them), which they are:
 * the generated themes.css emits plain hex.
 */
function mermaidThemeVariables(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const charts = [1, 2, 3, 4, 5].map((i) =>
    token(cs, `--chart-${i}`, ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'][i - 1]!),
  );
  const foreground = token(cs, '--foreground', '#1f2328');
  const mutedForeground = token(cs, '--muted-foreground', '#59636e');
  const card = token(cs, '--card', '#ffffff');
  const muted = token(cs, '--muted', '#f6f8fa');
  const border = token(cs, '--border', '#d1d9e0');
  const background = token(cs, '--background', '#ffffff');
  const vars: Record<string, string> = {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    background,
    mainBkg: muted,
    primaryColor: muted,
    primaryTextColor: foreground,
    primaryBorderColor: border,
    secondaryColor: card,
    secondaryTextColor: foreground,
    secondaryBorderColor: border,
    tertiaryColor: background,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: border,
    lineColor: mutedForeground,
    textColor: foreground,
    noteBkgColor: muted,
    noteTextColor: foreground,
    noteBorderColor: border,
  };
  charts.forEach((c, i) => {
    vars[`pie${i + 1}`] = c;
    vars[`cScale${i}`] = c;
    vars[`git${i}`] = c;
  });
  return vars;
}

let renderSeq = 0;

/** Render source → SVG with the current theme. Throws on parse/render errors
 *  and on timeout; never leaves mermaid's temp element behind. */
async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    // Agent/user-supplied source: strict disables click handlers + script-ish
    // directives; htmlLabels off keeps output plain SVG (no foreignObject),
    // matching the house SVG policy and the slice-2 server sanitizer.
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: mermaidThemeVariables(),
    flowchart: { htmlLabels: false },
  });
  const id = `mantle-diagram-${++renderSeq}`;
  try {
    const { svg } = await Promise.race([
      mermaid.render(id, source),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Diagram render timed out')), RENDER_TIMEOUT_MS),
      ),
    ]);
    return svg;
  } finally {
    // Mermaid can strand its temp element when a render throws mid-layout.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

/**
 * Dual-mode NodeView: rendered SVG by default; the source panel (monospace
 * textarea + debounced live preview) opens via the pencil, or automatically
 * when the source is empty. Errors show in a strip while the last good render
 * and the source are always kept — invalid input never blanks the block.
 */
export function DiagramView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const source = typeof node.attrs.source === 'string' ? node.attrs.source : '';
  const [draft, setDraft] = useState(source);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Never auto-open on mount: an empty diagram in a loading doc must not steal
  // focus (the draft watcher remounts the whole editor, which would re-fire
  // it). Editing opens only from a user click, so autoFocus is always wanted.
  const [editing, setEditing] = useState(false);
  const [themeEpoch, setThemeEpoch] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef(0);

  // Re-render when the theme or light/dark mode flips (app-sandbox precedent).
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeEpoch((e) => e + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // External changes to the node (undo, agent edits) refresh the panel when
  // it isn't the one doing the typing.
  useEffect(() => {
    if (!editing) setDraft(source);
  }, [source, editing]);

  const text = editing ? draft : source;

  useEffect(() => {
    const run = ++runRef.current;
    const trimmed = text.trim();
    if (!trimmed) {
      setSvg(null);
      setError(null);
      return;
    }
    if (trimmed.length > MAX_SOURCE_CHARS) {
      setError(`Diagram source is too large (max ${MAX_SOURCE_CHARS.toLocaleString()} characters)`);
      return;
    }
    const timer = setTimeout(() => {
      renderMermaid(trimmed)
        .then((out) => {
          if (runRef.current !== run) return;
          setSvg(out);
          setError(null);
        })
        .catch((err: unknown) => {
          if (runRef.current !== run) return;
          setError(err instanceof Error ? err.message : 'Diagram failed to render');
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, themeEpoch]);

  const commit = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (value !== node.attrs.source) updateAttributes({ source: value });
      }, DEBOUNCE_MS);
    },
    [node.attrs.source, updateAttributes],
  );
  // Unmount-only ([]): a per-render cleanup would cancel the pending commit on
  // every keystroke's re-render and source edits would never persist.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // Write the draft to the node NOW (blur, Done, Escape) — the debounce is
  // only for keystroke batching, never the thing persistence depends on.
  const flush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (draft !== node.attrs.source) updateAttributes({ source: draft });
  }, [draft, node.attrs.source, updateAttributes]);

  const closeEditor = useCallback(() => {
    flush();
    setEditing(false);
  }, [flush]);

  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <div
        contentEditable={false}
        data-diagram
        className={`group relative rounded-lg border bg-card p-3 ${
          selected ? 'border-primary' : 'border-border'
        }`}
      >
        {editor.isEditable && !editing && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Edit diagram source"
            className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        )}
        {editing && (
          <div className="mb-3">
            <textarea
              value={draft}
              autoFocus
              spellCheck={false}
              rows={Math.min(Math.max(draft.split('\n').length + 1, 4), 16)}
              placeholder={'flowchart LR\n  A[Start] --> B[Finish]'}
              className="w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-sm text-foreground outline-none focus:border-ring"
              onChange={(e) => {
                setDraft(e.target.value);
                commit(e.target.value);
              }}
              onBlur={flush}
              // Only Escape is intercepted (close the panel, keep it from PM).
              // Everything else must bubble: TipTap already ignores keys
              // targeting a TEXTAREA, and the page's window-level shortcuts
              // (⌘S commit, ⌘K palette) need the event to reach them.
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeEditor();
                }
              }}
            />
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" size="sm" onClick={closeEditor}>
                <Check />
                Done
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className="mb-2 flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
        {svg ? (
          <div
            className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
            // Mermaid output under securityLevel:'strict' + htmlLabels:false —
            // plain SVG from the user's own source, same trust model as the
            // KaTeX renderToString injection on the formulas surface.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : !error && text.trim() ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Rendering diagram…</div>
        ) : !text.trim() && !editing ? (
          editor.isEditable ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="w-full rounded-md py-6 text-center text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Empty diagram — click to add Mermaid source
            </button>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">Empty diagram</div>
          )
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
