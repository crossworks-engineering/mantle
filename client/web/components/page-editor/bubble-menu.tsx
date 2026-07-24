'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { HIGHLIGHT_TOKENS, highlightColor } from '@mantle/web-ui/highlight-colors';
import { TEXT_COLOR_TOKENS, textColor } from '@mantle/web-ui/text-colors';
import {
  Baseline,
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
import { Button } from '@mantle/web-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { Separator } from '@mantle/web-ui/ui/separator';
import { cn } from '@mantle/web-ui/lib/utils';

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

type Swatch = { key: string; label: string; color: string | null; onSelect: () => void };

/**
 * Colour swatch popover (highlight + text colour). Rendered as a sibling portal
 * positioned at the captured trigger rect, so it survives the bubble menu hiding
 * when the editor blurs. `color: null` is the "remove" swatch (a crossed circle);
 * onMouseDown+preventDefault keeps the editor's selection so the command applies.
 */
function SwatchPanel({
  pos,
  onClose,
  swatches,
}: {
  pos: { x: number; y: number };
  onClose: () => void;
  swatches: Swatch[];
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        className="fixed z-50 flex items-center gap-1.5 rounded-md border border-border bg-popover p-1.5 shadow-md"
        style={{ left: pos.x, top: pos.y }}
      >
        {swatches.map((sw) => (
          <button
            key={sw.key}
            type="button"
            aria-label={sw.label}
            title={sw.label}
            onMouseDown={(e) => {
              e.preventDefault();
              sw.onSelect();
            }}
            className={cn(
              'size-5 rounded-full border border-border',
              sw.color === null &&
                'flex items-center justify-center bg-background text-muted-foreground',
            )}
            style={sw.color ? { backgroundColor: sw.color } : undefined}
          >
            {sw.color === null && <span className="block h-px w-3 rotate-45 bg-current" />}
          </button>
        ))}
      </div>
    </>,
    document.body,
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
      textColor: editor.isActive('textColor'),
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

  // Text (font) colour swatches — same sibling-portal pattern as highlight.
  const [fcPanel, setFcPanel] = useState<{ x: number; y: number } | null>(null);

  const openTextColor = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setFcPanel({
      x: Math.min(r.left, window.innerWidth - 240),
      y: Math.min(r.bottom + 6, window.innerHeight - 60),
    });
  };
  const applyTextColor = (color: string) => {
    editor.chain().focus().setTextColor(color).run();
    setFcPanel(null);
  };
  const clearTextColor = () => {
    editor.chain().focus().unsetTextColor().run();
    setFcPanel(null);
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
          label="Text colour"
          icon={Baseline}
          active={s.textColor}
          onClick={openTextColor}
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

      {hlPanel && (
        <SwatchPanel
          pos={hlPanel}
          onClose={() => setHlPanel(null)}
          swatches={[
            { key: 'none', label: 'No highlight', color: null, onSelect: clearHighlight },
            {
              key: 'default',
              label: 'Default',
              color: 'color-mix(in oklab, var(--primary) 30%, transparent)',
              onSelect: applyDefaultHighlight,
            },
            ...HIGHLIGHT_TOKENS.map((token) => ({
              key: token,
              label: `Highlight ${token}`,
              color: highlightColor(token),
              onSelect: () => applyHighlight(token),
            })),
          ]}
        />
      )}

      {fcPanel && (
        <SwatchPanel
          pos={fcPanel}
          onClose={() => setFcPanel(null)}
          swatches={[
            { key: 'none', label: 'No colour', color: null, onSelect: clearTextColor },
            ...TEXT_COLOR_TOKENS.map((token) => ({
              key: token,
              label: `Text ${token}`,
              color: textColor(token),
              onSelect: () => applyTextColor(token),
            })),
          ]}
        />
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
