'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Lightweight, dependency-free emoji picker. A curated set (the kinds of icons
 * people actually pin to documents) grouped into sections, with keyword search.
 * Built in a Popover so any trigger can host it. Deliberately NOT a full Unicode
 * picker — that needs a ~500KB data dep we don't want in the web bundle; this
 * covers the common cases and the keyword index keeps search useful.
 *
 * `value` is the currently-selected emoji (highlighted). `onSelect` fires with
 * the chosen emoji; `onClear` (when provided) renders a "Remove" action.
 */

type EmojiEntry = { e: string; k: string };
type EmojiSection = { name: string; items: EmojiEntry[] };

// k = space-joined search keywords. Kept terse; search is substring over k.
const SECTIONS: EmojiSection[] = [
  {
    name: 'Docs & work',
    items: [
      { e: '📄', k: 'page document file paper' },
      { e: '📝', k: 'memo note write edit' },
      { e: '📋', k: 'clipboard list tasks' },
      { e: '📑', k: 'tabs bookmark sections' },
      { e: '🗒️', k: 'notepad notes spiral' },
      { e: '📓', k: 'notebook journal' },
      { e: '📔', k: 'notebook decorative journal' },
      { e: '📚', k: 'books library docs' },
      { e: '📖', k: 'book open reading' },
      { e: '📁', k: 'folder files' },
      { e: '📂', k: 'folder open' },
      { e: '🗂️', k: 'dividers index organize' },
      { e: '🗃️', k: 'card box archive' },
      { e: '📊', k: 'bar chart stats data' },
      { e: '📈', k: 'chart up growth trend' },
      { e: '📉', k: 'chart down decline' },
      { e: '🧾', k: 'receipt invoice bill' },
      { e: '📅', k: 'calendar date schedule' },
      { e: '📆', k: 'calendar tear date' },
      { e: '🗓️', k: 'calendar spiral planner' },
      { e: '📌', k: 'pushpin pin important' },
      { e: '📎', k: 'paperclip attach' },
      { e: '✏️', k: 'pencil write edit' },
      { e: '🖊️', k: 'pen write' },
      { e: '🖋️', k: 'fountain pen sign' },
      { e: '✂️', k: 'scissors cut' },
      { e: '🔖', k: 'bookmark tag label' },
      { e: '🏷️', k: 'label tag price' },
    ],
  },
  {
    name: 'Ideas & symbols',
    items: [
      { e: '💡', k: 'idea bulb light insight' },
      { e: '✅', k: 'check done complete tick' },
      { e: '☑️', k: 'checkbox checked done' },
      { e: '✔️', k: 'check tick yes' },
      { e: '❌', k: 'x cross no error' },
      { e: '⭐', k: 'star favorite important' },
      { e: '🌟', k: 'star glowing special' },
      { e: '🔥', k: 'fire hot trending' },
      { e: '⚡', k: 'lightning fast bolt energy' },
      { e: '❗', k: 'exclamation important alert' },
      { e: '❓', k: 'question help unknown' },
      { e: '⚠️', k: 'warning caution alert' },
      { e: '🚀', k: 'rocket launch ship fast' },
      { e: '🎯', k: 'target goal aim' },
      { e: '🏆', k: 'trophy win award goal' },
      { e: '🎉', k: 'party celebrate launch' },
      { e: '🔑', k: 'key access secret' },
      { e: '🔒', k: 'lock secure private' },
      { e: '🔓', k: 'unlock open' },
      { e: '🔔', k: 'bell notify reminder' },
      { e: '💬', k: 'speech chat comment' },
      { e: '🗨️', k: 'speech left chat' },
      { e: '♻️', k: 'recycle loop process' },
      { e: '🔗', k: 'link chain url' },
      { e: '➡️', k: 'arrow right next' },
      { e: '🆕', k: 'new badge' },
      { e: '🆗', k: 'ok button' },
      { e: '#️⃣', k: 'hash number tag' },
    ],
  },
  {
    name: 'People & places',
    items: [
      { e: '👤', k: 'person user profile contact' },
      { e: '👥', k: 'people group team users' },
      { e: '🧑‍💻', k: 'developer coder engineer tech' },
      { e: '🤝', k: 'handshake deal partner agree' },
      { e: '🏢', k: 'office building company org' },
      { e: '🏠', k: 'house home' },
      { e: '🌍', k: 'globe world earth map' },
      { e: '🗺️', k: 'map location travel' },
      { e: '📍', k: 'pin location place marker' },
      { e: '🧭', k: 'compass direction navigate' },
      { e: '✈️', k: 'plane travel flight' },
      { e: '🚗', k: 'car drive vehicle' },
      { e: '🏦', k: 'bank finance money' },
      { e: '🏥', k: 'hospital health medical' },
      { e: '🏫', k: 'school education' },
      { e: '⛪', k: 'church faith worship' },
    ],
  },
  {
    name: 'Money & objects',
    items: [
      { e: '💰', k: 'money bag cash finance' },
      { e: '💵', k: 'dollar cash money bill' },
      { e: '💳', k: 'card credit payment' },
      { e: '🪙', k: 'coin money currency' },
      { e: '💎', k: 'gem diamond value' },
      { e: '📦', k: 'box package shipping product' },
      { e: '🛒', k: 'cart shopping buy' },
      { e: '🧰', k: 'toolbox tools fix' },
      { e: '🔧', k: 'wrench fix tool settings' },
      { e: '⚙️', k: 'gear settings config' },
      { e: '🖥️', k: 'desktop computer pc' },
      { e: '💻', k: 'laptop computer code' },
      { e: '📱', k: 'phone mobile device' },
      { e: '⌚', k: 'watch time wearable' },
      { e: '🔋', k: 'battery power energy' },
      { e: '📡', k: 'satellite signal network' },
      { e: '🛡️', k: 'shield protect security' },
      { e: '🧪', k: 'test tube experiment lab science' },
      { e: '🔬', k: 'microscope research science' },
      { e: '🧠', k: 'brain mind smart think' },
    ],
  },
  {
    name: 'Nature & food',
    items: [
      { e: '🌱', k: 'seedling grow plant start' },
      { e: '🌳', k: 'tree nature' },
      { e: '🍀', k: 'clover luck' },
      { e: '🌸', k: 'blossom flower spring' },
      { e: '🌊', k: 'wave water ocean' },
      { e: '☀️', k: 'sun sunny day' },
      { e: '🌙', k: 'moon night' },
      { e: '⛅', k: 'cloud weather' },
      { e: '❄️', k: 'snow cold winter' },
      { e: '🍎', k: 'apple fruit food' },
      { e: '☕', k: 'coffee drink cafe' },
      { e: '🍕', k: 'pizza food' },
      { e: '🎂', k: 'cake birthday' },
      { e: '🐶', k: 'dog pet animal' },
      { e: '🐱', k: 'cat pet animal' },
      { e: '🦊', k: 'fox animal' },
    ],
  },
];

const ALL: EmojiEntry[] = SECTIONS.flatMap((s) => s.items);

export function EmojiPicker({
  value,
  onSelect,
  onClear,
  trigger,
  align = 'start',
}: {
  value?: string | null;
  onSelect: (emoji: string) => void;
  onClear?: () => void;
  trigger: ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const query = q.trim().toLowerCase();
  // While searching we flatten across sections; otherwise show the grouped set.
  const matches = useMemo(() => (query ? ALL.filter((x) => x.k.includes(query)) : null), [query]);

  const choose = (emoji: string) => {
    onSelect(emoji);
    setOpen(false);
    setQ('');
  };

  const cell = (x: EmojiEntry) => (
    <button
      key={x.e}
      type="button"
      onClick={() => choose(x.e)}
      title={x.k.split(' ')[0]}
      className={cn(
        'flex aspect-square items-center justify-center rounded text-xl transition-colors hover:bg-accent hover:text-accent-foreground',
        value === x.e && 'bg-accent text-accent-foreground',
      )}
    >
      {x.e}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ('');
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search emoji…"
          className="mb-2 h-8"
          autoFocus
        />
        <div className="max-h-56 overflow-y-auto scrollbar-thin">
          {matches ? (
            matches.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No emoji found.</p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">{matches.map(cell)}</div>
            )
          ) : (
            SECTIONS.map((s) => (
              <div key={s.name} className="mb-1.5">
                <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {s.name}
                </p>
                <div className="grid grid-cols-8 gap-0.5">{s.items.map(cell)}</div>
              </div>
            ))
          )}
        </div>
        {onClear && (
          <div className="mt-1 flex justify-end border-t border-border pt-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              disabled={!value}
              onClick={() => {
                onClear();
                setOpen(false);
                setQ('');
              }}
            >
              Remove icon
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
