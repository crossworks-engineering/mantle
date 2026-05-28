'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import type { ChainedCommands, Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Info,
  List,
  ListOrdered,
  ListTodo,
  Replace,
  TextQuote,
  Trash2,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * "Turn into" conversions offered on the handle menu. Deliberately limited to
 * the block types a conversion makes obvious sense for — no table / columns /
 * image / divider (those are inserts, not transforms). Each `apply` runs
 * against a chain whose selection is already inside the target block.
 */
const TURN_OPTIONS: {
  label: string;
  icon: LucideIcon;
  apply: (c: ChainedCommands) => ChainedCommands;
}[] = [
  { label: 'Text', icon: Type, apply: (c) => c.setNode('paragraph') },
  { label: 'Heading 1', icon: Heading1, apply: (c) => c.setNode('heading', { level: 1 }) },
  { label: 'Heading 2', icon: Heading2, apply: (c) => c.setNode('heading', { level: 2 }) },
  { label: 'Heading 3', icon: Heading3, apply: (c) => c.setNode('heading', { level: 3 }) },
  { label: 'Bulleted list', icon: List, apply: (c) => c.toggleBulletList() },
  { label: 'Numbered list', icon: ListOrdered, apply: (c) => c.toggleOrderedList() },
  { label: 'To-do list', icon: ListTodo, apply: (c) => c.toggleTaskList() },
  { label: 'Quote', icon: TextQuote, apply: (c) => c.toggleBlockquote() },
  { label: 'Callout', icon: Info, apply: (c) => c.wrapIn('callout', { variant: 'info' }) },
  { label: 'Code', icon: Code2, apply: (c) => c.toggleCodeBlock() },
];

/**
 * Block gutter handle — one grip that does both: drag to reorder, click for
 * actions (Turn into… / Duplicate / Delete on the block it's over).
 *
 * The grip is a plain element with a native onClick. We deliberately do NOT
 * wrap it in a Radix menu trigger: the trigger preventDefaults pointerdown,
 * which swallows the native dragstart (the old "grab cursor but no movement"
 * bug). A plain onClick fires only on a click (not a drag), so both coexist —
 * so the menu is a small custom popover portaled to <body> rather than the
 * shadcn DropdownMenu.
 */
export function EditorDragHandle({ editor }: { editor: Editor }) {
  const posRef = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [turnOpen, setTurnOpen] = useState(false);

  const openMenu = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTurnOpen(false);
    setMenu({
      x: Math.min(r.right + 6, window.innerWidth - 232),
      y: Math.min(r.top, window.innerHeight - 96),
    });
  };
  const close = () => {
    setMenu(null);
    setTurnOpen(false);
  };

  const remove = () => {
    const pos = posRef.current;
    close();
    if (pos == null || pos < 0) return;
    editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
  };

  const duplicate = () => {
    const pos = posRef.current;
    close();
    if (pos == null || pos < 0) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run();
  };

  // Convert the target block. Drop the cursor inside it first, then run the
  // conversion command (setNode / toggleList / wrapIn) against that selection.
  // The block's stable id is a global attribute, so it carries across setNode
  // (a marked/edited highlight stays put through the turn-into).
  const turnInto = (apply: (c: ChainedCommands) => ChainedCommands) => {
    const pos = posRef.current;
    close();
    if (pos == null || pos < 0) return;
    if (!editor.state.doc.nodeAt(pos)) return;
    apply(editor.chain().focus().setTextSelection(pos + 1)).run();
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Stable props for <DragHandle>. Its internal effect re-registers the
  // ProseMirror plugin whenever these change; a fresh object/function each render
  // makes it churn on every re-render (e.g. the idle autosave), which
  // reconfigures editor state and tears down this menu and the slash/mention
  // popups. posRef is a ref, so [] deps are safe.
  // `left` (vs the default `left-start`) centres the handle on the block's box
  // instead of top-anchoring it — so the grip lines up with its row, including
  // thin blocks like a divider.
  const computePositionConfig = useMemo(() => ({ placement: 'left' as const }), []);
  const onNodeChange = useCallback<NonNullable<ComponentProps<typeof DragHandle>['onNodeChange']>>(
    ({ node, pos }) => {
      posRef.current = node ? pos : null;
    },
    [],
  );

  return (
    <>
      <DragHandle
        editor={editor}
        computePositionConfig={computePositionConfig}
        onNodeChange={onNodeChange}
      >
        <div
          role="button"
          aria-label="Drag to move · click for actions"
          onClick={openMenu}
          // mr-1.5 keeps a small gap from the text; the grip still lands inside
          // the editor's left padding (see globals.css) so reaching for it never
          // leaves the editor and triggers the library's hide-on-mouseleave.
          className="mr-1.5 flex h-9 w-7 cursor-grab items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-6" aria-hidden />
        </div>
      </DragHandle>

      {menu &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={close}
              onContextMenu={(e) => {
                e.preventDefault();
                close();
              }}
            />
            <div
              role="menu"
              className="fixed z-50 min-w-52 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
              style={{ left: menu.x, top: menu.y, maxHeight: `calc(100vh - ${menu.y + 8}px)` }}
            >
              {/* Turn into — inline-expanding section (no flyout positioning). */}
              <button
                type="button"
                onClick={() => setTurnOpen((v) => !v)}
                aria-expanded={turnOpen}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Replace className="size-4" aria-hidden />
                Turn into
                <span className="ml-auto text-muted-foreground">
                  {turnOpen ? (
                    <ChevronDown className="size-4" aria-hidden />
                  ) : (
                    <ChevronRight className="size-4" aria-hidden />
                  )}
                </span>
              </button>
              {turnOpen && (
                <div className="mb-1 ml-3 border-l border-border pl-1">
                  {TURN_OPTIONS.map((o) => (
                    <MenuItem
                      key={o.label}
                      icon={o.icon}
                      label={o.label}
                      onClick={() => turnInto(o.apply)}
                    />
                  ))}
                </div>
              )}

              <div className="my-1 h-px bg-border" />
              <MenuItem icon={Copy} label="Duplicate" onClick={duplicate} />
              <MenuItem icon={Trash2} label="Delete" onClick={remove} destructive />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-accent',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );
}
