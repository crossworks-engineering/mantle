'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Editor, Range } from '@tiptap/core';
import {
  Code2,
  Columns2,
  Columns3,
  Columns4,
  Heading1,
  Heading2,
  Heading3,
  Info,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Table as TableIcon,
  TextQuote,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { columnsContent } from './column';

export type SlashItem = {
  title: string;
  description: string;
  group: string;
  icon: LucideIcon;
  keywords?: string[];
  command: (opts: { editor: Editor; range: Range }) => void;
};

const ITEMS: SlashItem[] = [
  {
    group: 'Basic',
    title: 'Text',
    description: 'Plain paragraph.',
    icon: Type,
    keywords: ['paragraph', 'p', 'body'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    group: 'Basic',
    title: 'Heading 1',
    description: 'Large section heading.',
    icon: Heading1,
    keywords: ['h1', 'title', 'big'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    group: 'Basic',
    title: 'Heading 2',
    description: 'Medium section heading.',
    icon: Heading2,
    keywords: ['h2', 'subtitle'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    group: 'Basic',
    title: 'Heading 3',
    description: 'Small section heading.',
    icon: Heading3,
    keywords: ['h3'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    group: 'Lists',
    title: 'Bulleted list',
    description: 'A simple bullet list.',
    icon: List,
    keywords: ['ul', 'unordered', 'bullet'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    group: 'Lists',
    title: 'Numbered list',
    description: 'A list with ordering.',
    icon: ListOrdered,
    keywords: ['ol', 'ordered', 'number'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    group: 'Lists',
    title: 'To-do list',
    description: 'A checklist with checkboxes.',
    icon: ListTodo,
    keywords: ['task', 'todo', 'checkbox', 'check'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    group: 'Blocks',
    title: 'Quote',
    description: 'Capture a quotation.',
    icon: TextQuote,
    keywords: ['blockquote', 'citation'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    group: 'Blocks',
    title: 'Callout',
    description: 'A highlighted info box.',
    icon: Info,
    keywords: ['note', 'aside', 'tip', 'warning', 'info'],
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph' }],
        })
        .run(),
  },
  {
    group: 'Blocks',
    title: 'Code',
    description: 'A formatted code block.',
    icon: Code2,
    keywords: ['codeblock', 'pre', 'monospace'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    group: 'Blocks',
    title: 'Divider',
    description: 'A horizontal rule.',
    icon: Minus,
    keywords: ['hr', 'rule', 'separator', '---'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    group: 'Blocks',
    title: 'Table',
    description: 'A simple table (add rows/columns with +).',
    icon: TableIcon,
    keywords: ['grid', 'cells', 'spreadsheet', 'rows'],
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
        .run(),
  },
  {
    group: 'Columns',
    title: '2 columns',
    description: 'Two side-by-side columns.',
    icon: Columns2,
    keywords: ['column', 'grid', 'layout', 'split', '2'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent(columnsContent(2)).run(),
  },
  {
    group: 'Columns',
    title: '3 columns',
    description: 'Three side-by-side columns.',
    icon: Columns3,
    keywords: ['column', 'grid', 'layout', 'split', '3'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent(columnsContent(3)).run(),
  },
  {
    group: 'Columns',
    title: '4 columns',
    description: 'Four side-by-side columns.',
    icon: Columns4,
    keywords: ['column', 'grid', 'layout', 'split', '4'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent(columnsContent(4)).run(),
  },
];

/** Filter the command list by the text typed after the slash. */
export function getSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (i) => i.title.toLowerCase().includes(q) || (i.keywords ?? []).some((k) => k.includes(q)),
  );
}

export type SlashMenuProps = {
  items: SlashItem[];
  command: (item: SlashItem) => void;
};

export type SlashMenuHandle = { onKeyDown: (p: { event: KeyboardEvent }) => boolean };

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(0), [items]);

  // Keep the highlighted row in view during keyboard navigation.
  useLayoutEffect(() => {
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (i: number) => {
    const item = items[i];
    if (item) command(item);
  };

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected((s) => (s - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          choose(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected],
  );

  if (items.length === 0) {
    return (
      <div className="w-80 rounded-xl border border-border bg-popover p-4 text-sm text-muted-foreground shadow-lg">
        No matching blocks
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="max-h-[22rem] w-80 overflow-y-auto scrollbar-thin rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
    >
      {items.map((item, i) => {
        const showGroup = i === 0 || items[i - 1]?.group !== item.group;
        const Icon = item.icon;
        return (
          <div key={item.title}>
            {showGroup && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {item.group}
              </div>
            )}
            <button
              type="button"
              data-index={i}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(i)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                i === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight">{item.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
});
