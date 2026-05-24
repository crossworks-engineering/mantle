'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { HIGHLIGHT_TOKENS, highlightColor } from './highlight-colors';
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

function ToolButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn('size-8', active && 'bg-accent text-accent-foreground')}
    >
      <Icon />
    </Button>
  );
}

/**
 * Selection bubble menu — the chromeless replacement for a fixed toolbar.
 * The link dialog is rendered as a SIBLING of <BubbleMenu> (not a child): when
 * focus moves into the URL input the menu hides, but the component stays
 * mounted, so the dialog survives. setLink applies to the preserved selection.
 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');

  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('codeBlock'),
      highlight: editor.isActive('highlight'),
      link: editor.isActive('link'),
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      quote: editor.isActive('blockquote'),
    }),
  });

  // Highlight colour swatches. Opened from the Highlighter button; rendered as a
  // fixed panel at the captured button rect (a sibling portal, like the
  // drag-handle menu) so it survives the bubble menu hiding when the editor
  // blurs. Commands run editor.chain().focus() against the preserved selection.
  const [hlPanel, setHlPanel] = useState<{ x: number; y: number } | null>(null);

  const openHighlight = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHlPanel({
      x: Math.min(r.left, window.innerWidth - 240),
      y: Math.min(r.bottom + 6, window.innerHeight - 60),
    });
  };
  const applyHighlight = (color: string) => {
    editor.chain().focus().setHighlight({ color }).run();
    setHlPanel(null);
  };
  const applyDefaultHighlight = () => {
    editor.chain().focus().setHighlight().run();
    setHlPanel(null);
  };
  const clearHighlight = () => {
    editor.chain().focus().unsetHighlight().run();
    setHlPanel(null);
  };

  const openLink = () => {
    setHref((editor.getAttributes('link').href as string) ?? '');
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkOpen(false);
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
  };

  return (
    <>
      <BubbleMenu
        editor={editor}
        className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <ToolButton
          label="Bold"
          icon={Bold}
          active={s.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolButton
          label="Italic"
          icon={Italic}
          active={s.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolButton
          label="Strikethrough"
          icon={Strikethrough}
          active={s.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
        <ToolButton
          label="Highlight colour"
          icon={Highlighter}
          active={s.highlight}
          onClick={openHighlight}
        />
        <ToolButton label="Link" icon={Link2} active={s.link} onClick={openLink} />
        <ToolButton
          label="Inline code block"
          icon={Code2}
          active={s.code}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        />

        <Separator orientation="vertical" className="mx-1 h-6" />

        <ToolButton
          label="Heading 1"
          icon={Heading1}
          active={s.h1}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolButton
          label="Heading 2"
          icon={Heading2}
          active={s.h2}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <ToolButton
          label="Bullet list"
          icon={List}
          active={s.bullet}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <ToolButton
          label="Numbered list"
          icon={ListOrdered}
          active={s.ordered}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
        <ToolButton
          label="Quote"
          icon={Quote}
          active={s.quote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
      </BubbleMenu>

      {hlPanel &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setHlPanel(null)} />
            <div
              role="menu"
              aria-label="Highlight colour"
              className="fixed z-50 flex items-center gap-1.5 rounded-md border border-border bg-popover p-1.5 shadow-md"
              style={{ left: hlPanel.x, top: hlPanel.y }}
            >
              <button
                type="button"
                aria-label="No highlight"
                title="None"
                onMouseDown={(e) => {
                  e.preventDefault();
                  clearHighlight();
                }}
                className="flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
              >
                <span className="block h-px w-3 rotate-45 bg-current" />
              </button>
              <button
                type="button"
                aria-label="Default highlight"
                title="Default"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyDefaultHighlight();
                }}
                className="size-5 rounded-full border border-border"
                style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 30%, transparent)' }}
              />
              {HIGHLIGHT_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  aria-label={`Highlight ${token}`}
                  title={token}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyHighlight(token);
                  }}
                  className="size-5 rounded-full border border-border"
                  style={{ backgroundColor: highlightColor(token) ?? undefined }}
                />
              ))}
            </div>
          </>,
          document.body,
        )}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{s.link ? 'Edit link' : 'Add link'}</DialogTitle>
            <DialogDescription>Paste or type a URL for the selected text.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                value={href}
                onChange={(e) => setHref(e.target.value)}
                placeholder="https://…"
                autoFocus
              />
            </div>
            <div className="flex justify-between gap-2">
              {s.link ? (
                <Button type="button" variant="ghost" onClick={removeLink}>
                  Remove
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit">Apply</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
