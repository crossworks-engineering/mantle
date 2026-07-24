'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@mantle/web-ui/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@mantle/web-ui/ui/popover';
import { Button } from '@mantle/web-ui/ui/button';
import { cn } from '@mantle/web-ui/lib/utils';
import type { ExplorerModel } from '@/lib/model-explorer';
import {
  formatContext,
  formatPriceCompact,
  hasPrice,
  isFree,
  sortModels,
  type ModelSelectSortKey,
} from './model-select-utils';

export type { ModelSelectSortKey };

/**
 * Searchable model picker — shadcn Popover + Command (cmdk) composition.
 *
 * One reusable surface for both /settings/agents (OpenRouter's keyless catalog,
 * ~330 models) and /settings/ai-workers (per-provider live discovery via
 * adapter `discoverModels()`). Renders a row per model with name, slug,
 * context window, and an input/output pricing badge when the provider returns
 * pricing (OpenRouter and Google do; OpenAI / Anthropic / xAI direct don't).
 *
 * Data is owned by the caller. The combobox is dumb about *where* `models`
 * came from — it just renders, sorts, and filters. That keeps it equally
 * usable against a live `fetch('/api/model-context')` payload, a server-action
 * discovery result, or a static catalog under test.
 *
 * Free-text fallback (`allowCustom`) lets the operator commit a slug that
 * isn't in the catalog — useful for brand-new models OpenRouter hasn't
 * indexed yet, or for typo-tolerant edits in an agent row. The current
 * value is always echoed in the selected summary even when it's not in
 * `models`, so an edit screen with a stale slug doesn't go blank.
 */
export interface ModelSelectProps {
  /** Currently selected model id (slug like `anthropic/claude-sonnet-4.6`
   *  or bare id like `gpt-4o` for direct providers). Free-text safe. */
  value: string;
  onValueChange: (next: string) => void;
  /** Live catalog rows to render. May be empty during initial load. */
  models: ExplorerModel[];
  /** Show a loading state in the popover. */
  loading?: boolean;
  /** Soft error to surface above the list (catalog refresh failed, etc.). */
  error?: string | null;
  /** Trigger button placeholder when no value is set. */
  placeholder?: string;
  /** What to say when search returns no matches. */
  emptyMessage?: string;
  /** Default sort key for the popover list. Operator can change live via
   *  the sort dropdown. */
  defaultSort?: ModelSelectSortKey;
  /** When true, the input search bar offers "Use ‹typed›" as a fallback
   *  row that commits the literal string. Default true — the operator
   *  can pin a slug we don't know about yet. */
  allowCustom?: boolean;
  /** Native-form-submission hidden-input name. Workers form posts via
   *  formData; agents form uses React state — set this only on the
   *  formData path. */
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ModelSelect({
  value,
  onValueChange,
  models,
  loading = false,
  error = null,
  placeholder = '— pick a model —',
  emptyMessage = 'No models found.',
  defaultSort = 'newest',
  allowCustom = true,
  name,
  id,
  required,
  disabled,
  className,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<ModelSelectSortKey>(defaultSort);
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // cmdk re-filters in place but never resets the scroll container, so after
  // scrolling down then typing, the (shorter) filtered list sits scrolled past
  // its top and looks empty. Snap back to the top whenever the query or sort
  // changes so the first match is always visible.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search, sort]);

  const sorted = useMemo(() => sortModels(models, sort), [models, sort]);
  const selected = models.find((m) => m.id === value);
  // Fallback summary when the current value isn't in `models` — e.g. edit
  // mode opening on a model the catalog has since dropped, or a custom
  // slug the operator pinned manually.
  const phantom: ExplorerModel | null = !selected && value ? { id: value, raw: null } : null;
  const commit = (next: string) => {
    onValueChange(next);
    setOpen(false);
    setSearch('');
  };
  const trimmed = search.trim();
  const showCustomRow =
    allowCustom &&
    trimmed.length > 0 &&
    !sorted.some((m) => m.id.toLowerCase() === trimmed.toLowerCase());

  return (
    <>
      {/* Hidden input keeps native <form action> submissions populated when
          the caller is on formData (workers form). Controlled-state callers
          omit `name` and read `value` directly. */}
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            data-required={required ? '' : undefined}
            className={cn(
              'h-9 w-full justify-between gap-2 font-normal',
              !value && 'text-muted-foreground',
              className,
            )}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selected ? (
                <SelectedSummary model={selected} />
              ) : phantom ? (
                <span className="font-medium">{phantom.id}</span>
              ) : (
                placeholder
              )}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command shouldFilter>
            <div className="flex items-center gap-1 border-b border-border">
              <CommandInput
                value={search}
                onValueChange={setSearch}
                placeholder="Search models…"
                className="border-0 focus:ring-0"
              />
              <SortDropdown value={sort} onChange={setSort} />
            </div>
            <CommandList ref={listRef} className="max-h-80">
              {loading && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Loading models…
                </div>
              )}
              {error && !loading && (
                <div className="border-b border-border bg-muted/50 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  {error}
                </div>
              )}
              {!loading && sorted.length === 0 && !showCustomRow && (
                <CommandEmpty className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {emptyMessage}
                </CommandEmpty>
              )}
              {sorted.length > 0 && (
                <CommandGroup>
                  {sorted.map((m) => (
                    <CommandItem
                      key={m.id}
                      // cmdk filters on this string — include id + name +
                      // modality so a search like "vision" hits multimodal
                      // rows without us having to maintain a tag index.
                      value={`${m.id} ${m.name ?? ''} ${m.modality ?? ''}`}
                      onSelect={() => commit(m.id)}
                      className="!py-2"
                    >
                      <ModelRow model={m} selected={m.id === value} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {showCustomRow && (
                <CommandGroup heading="Custom">
                  <CommandItem
                    value={`__custom__ ${trimmed}`}
                    onSelect={() => commit(trimmed)}
                    className="!py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        Use <span className="font-medium tabular-nums">{trimmed}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Save as a custom slug — make sure your key has access.
                      </div>
                    </div>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

// ── internals ───────────────────────────────────────────────────────────────

/** One-line summary shown inside the trigger Button when a model is chosen. */
function SelectedSummary({ model }: { model: ExplorerModel }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-medium">{model.name ?? model.id}</span>
      {model.contextTokens != null && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatContext(model.contextTokens)}
        </span>
      )}
      {hasPrice(model) && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatPriceCompact(model)}
        </span>
      )}
    </span>
  );
}

/** Full row layout for the popover list — name on top, slug + context +
 *  pricing on the muted line below. Wraps gracefully if the popover is narrow. */
function ModelRow({ model, selected }: { model: ExplorerModel; selected: boolean }) {
  return (
    <div className="flex w-full min-w-0 items-start gap-2">
      <Check className={cn('mt-1 size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-medium">{model.name ?? model.id}</span>
          {model.contextTokens != null && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {formatContext(model.contextTokens)}
            </span>
          )}
          {hasPrice(model) && (
            <span className="shrink-0 rounded bg-accent/40 px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
              {formatPriceCompact(model)}
            </span>
          )}
          {isFree(model) && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              free
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {model.name && model.name !== model.id ? model.id : null}
          {model.modality && model.name && model.name !== model.id ? ' · ' : null}
          {model.modality}
        </div>
      </div>
    </div>
  );
}

/** Compact sort dropdown lives inside the search row, right-aligned. */
function SortDropdown({
  value,
  onChange,
}: {
  value: ModelSelectSortKey;
  onChange: (k: ModelSelectSortKey) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ModelSelectSortKey)}
      className="mr-2 h-7 rounded border border-input bg-transparent px-1.5 text-[11px] text-muted-foreground focus:outline-none"
      aria-label="Sort models"
    >
      <option value="newest">newest</option>
      <option value="name">name</option>
      <option value="cheapest">cheapest</option>
      <option value="context">context</option>
    </select>
  );
}
