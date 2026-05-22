'use client';

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bold,
  Code,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  PencilLine,
  Quote,
  SplitSquareHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

type Mode = 'edit' | 'split' | 'preview';

/**
 * Reusable markdown editor: a formatting toolbar that operates on the
 * textarea selection, an Edit / Split / Preview toggle, and a live
 * GFM-rendered preview. Controlled via `value` / `onChange`.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  height = 'h-[30rem]',
  defaultMode = 'split',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Tailwind height class for the editor body. */
  height?: string;
  defaultMode?: Mode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>(defaultMode);

  /** Apply a transform to the current selection, then restore the caret. */
  function transform(fn: (selected: string) => { text: string; selStart: number; selEnd: number }) {
    const ta = ref.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const { text, selStart, selEnd } = fn(value.slice(start, end));
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + selStart, start + selEnd);
    });
  }

  const wrap = (token: string) =>
    transform((sel) =>
      sel
        ? { text: `${token}${sel}${token}`, selStart: token.length, selEnd: token.length + sel.length }
        : { text: `${token}${token}`, selStart: token.length, selEnd: token.length },
    );

  const linePrefix = (prefix: string) =>
    transform((sel) => {
      const out = (sel || '')
        .split('\n')
        .map((l) => `${prefix}${l}`)
        .join('\n');
      return { text: out, selStart: prefix.length, selEnd: out.length };
    });

  const insertLink = () =>
    transform((sel) =>
      sel
        ? { text: `[${sel}](url)`, selStart: sel.length + 3, selEnd: sel.length + 6 }
        : { text: '[text](url)', selStart: 1, selEnd: 5 },
    );

  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-muted/30 p-1">
        <ToolbarButton label="Bold (**)" onClick={() => wrap('**')}>
          <Bold />
        </ToolbarButton>
        <ToolbarButton label="Italic (*)" onClick={() => wrap('*')}>
          <Italic />
        </ToolbarButton>
        <ToolbarButton label="Inline code (`)" onClick={() => wrap('`')}>
          <Code />
        </ToolbarButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToolbarButton label="Heading" onClick={() => linePrefix('## ')}>
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton label="Bullet list" onClick={() => linePrefix('- ')}>
          <List />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" onClick={() => linePrefix('1. ')}>
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton label="Quote" onClick={() => linePrefix('> ')}>
          <Quote />
        </ToolbarButton>
        <ToolbarButton label="Link" onClick={insertLink}>
          <Link2 />
        </ToolbarButton>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as Mode)}
          className="ml-auto"
        >
          <ToggleGroupItem value="edit" aria-label="Edit only">
            <PencilLine />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="Split view">
            <SplitSquareHorizontal />
          </ToggleGroupItem>
          <ToggleGroupItem value="preview" aria-label="Preview only">
            <Eye />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Body */}
      <div className={cn('flex overflow-hidden rounded-md border border-input', height)}>
        {showEditor && (
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck
            className={cn(
              'h-full resize-none bg-transparent p-3 font-mono text-sm focus:outline-none',
              mode === 'split' ? 'w-1/2 border-r border-border' : 'flex-1',
            )}
          />
        )}
        {showPreview && (
          <article
            className={cn(
              'prose prose-sm dark:prose-invert h-full max-w-none overflow-y-auto p-4',
              mode === 'split' ? 'w-1/2' : 'flex-1',
            )}
          >
            {value.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            ) : (
              <p className="text-sm italic text-muted-foreground">Nothing to preview yet.</p>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
