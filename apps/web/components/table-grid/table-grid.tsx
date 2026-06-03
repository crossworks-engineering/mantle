'use client';

/**
 * The editable typed-grid. Renders a TableDoc with TanStack Table for the
 * header/row model + client sorting, and type-aware editable cells. Every edit
 * runs through the shared pure model ops (@mantle/content/table-model) and
 * hands the parent a new doc via `onChange` — the parent autosaves it to the
 * table's draft. Display follows the house rules: accent-only row selection,
 * neutral hover, theme tokens, no hardcoded colours.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  Calendar,
  CalendarClock,
  Check,
  ChevronsUpDown,
  CircleCheck,
  CircleSlash,
  DollarSign,
  Divide,
  Hash,
  Link,
  List,
  ListOrdered,
  ListPlus,
  Percent,
  Plus,
  Sigma,
  SquareCheck,
  Tags,
  Trash2,
  Type,
  Variable,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  addColumn,
  addRow,
  addSelectOption,
  AGGREGATE_KINDS,
  COLUMN_TYPES,
  coerceCell,
  computeAggregate,
  deleteColumn,
  deleteRow,
  resolveCell,
  setAggregate,
  setCell,
  updateColumn,
  type AggregateKind,
  type CellValue,
  type Column,
  type ColumnType,
  type Row,
  type TableDoc,
} from '@mantle/content/table-model';

const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  date: 'Date',
  datetime: 'Date & time',
  checkbox: 'Checkbox',
  select: 'Select',
  multiselect: 'Multi-select',
  url: 'URL',
  formula: 'Formula',
};

const TYPE_ICON: Record<ColumnType, LucideIcon> = {
  text: Type,
  number: Hash,
  currency: DollarSign,
  percent: Percent,
  date: Calendar,
  datetime: CalendarClock,
  checkbox: SquareCheck,
  select: List,
  multiselect: Tags,
  url: Link,
  formula: Variable,
};

const AGG_ICON: Record<AggregateKind, LucideIcon> = {
  none: Ban,
  sum: Sigma,
  avg: Divide,
  count: ListOrdered,
  min: ArrowDownToLine,
  max: ArrowUpToLine,
  filled: CircleCheck,
  empty: CircleSlash,
};

const AGG_LABEL: Record<AggregateKind, string> = {
  none: 'None',
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Min',
  max: 'Max',
  filled: 'Filled',
  empty: 'Empty',
};

function displayValue(value: CellValue, col: Column): string {
  if (value === null || value === undefined || value === '') return '';
  if (col.type === 'currency') {
    const n = Number(value);
    return Number.isFinite(n) ? `${col.format?.currency ?? 'USD'} ${n.toFixed(col.format?.decimals ?? 2)}` : String(value);
  }
  if (col.type === 'percent') {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(col.format?.decimals ?? 0)}%` : String(value);
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function TableGrid({ doc, onChange }: { doc: TableDoc; onChange: (next: TableDoc) => void }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  // Live doc + onChange via refs so the column defs can stay referentially
  // STABLE across cell edits. Rebuilding `columns` on every keystroke makes
  // TanStack churn the body and the focused <input> loses its cursor (the same
  // re-render jank Pages hit). The defs only need to change when the column
  // STRUCTURE changes — captured below as `structureKey`.
  const docRef = useRef(doc);
  docRef.current = doc;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const structureKey = doc.columns
    .map((c) => `${c.id}:${c.type}:${c.name}:${c.formula ?? ''}:${(c.options ?? []).map((o) => o.label).join(',')}:${JSON.stringify(c.format ?? {})}`)
    .join('|') + `#${JSON.stringify(doc.aggregates ?? {})}`;

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    return docRef.current.columns.map((col) => ({
      id: col.id,
      accessorFn: (row) => resolveCell(docRef.current, row, col),
      enableSorting: true,
      header: ({ column }) => (
        <HeaderCell
          col={col}
          aggregate={docRef.current.aggregates?.[col.id] ?? 'none'}
          sortDir={column.getIsSorted() || null}
          onSort={(dir) => column.toggleSorting(dir === 'desc')}
          onClearSort={() => column.clearSorting()}
          onRename={(name) => onChangeRef.current(updateColumn(docRef.current, col.id, { name }))}
          onType={(type) => onChangeRef.current(updateColumn(docRef.current, col.id, { type }))}
          onAggregate={(kind) => onChangeRef.current(setAggregate(docRef.current, col.id, kind))}
          onInsertRight={() => onChangeRef.current(addColumn(docRef.current, { name: 'New column', type: 'text' }, col.id).doc)}
          onDelete={() => onChangeRef.current(deleteColumn(docRef.current, col.id))}
        />
      ),
      cell: (info) => (
        <EditableCell
          col={col}
          value={info.getValue() as CellValue}
          rawValue={(info.row.original.cells[col.id] ?? null) as CellValue}
          onSet={(v) => onChangeRef.current(setCell(docRef.current, info.row.original.id, col.id, v))}
          onApplyOption={({ value, newOption }) => {
            let d = docRef.current;
            if (newOption) d = addSelectOption(d, col.id, newOption);
            onChangeRef.current(setCell(d, info.row.original.id, col.id, value));
          }}
        />
      ),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const table = useReactTable({
    data: doc.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  const hasAggregates = Object.keys(doc.aggregates ?? {}).length > 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-border">
              <th className="w-10 px-2 py-1.5 text-left font-normal text-muted-foreground" aria-hidden />
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  className="min-w-[8rem] border-l border-border px-1 py-1 text-left align-top font-medium"
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
              <th className="w-10 px-1 py-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => onChange(addColumn(doc, { name: `Column ${doc.columns.length + 1}`, type: 'text' }).doc)}
                  aria-label="Add column"
                >
                  <Plus />
                </Button>
              </th>
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="group border-b border-border hover:bg-muted/40">
              <td className="px-2 py-1 text-center align-middle text-xs text-muted-foreground">
                <button
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={() => onChange(deleteRow(doc, row.id))}
                  aria-label="Delete row"
                  type="button"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </td>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="border-l border-border p-0 align-middle">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
              <td aria-hidden />
            </tr>
          ))}
          {doc.rows.length === 0 && (
            <tr>
              <td colSpan={doc.columns.length + 2} className="px-3 py-6 text-center text-sm text-muted-foreground">
                No rows yet.
              </td>
            </tr>
          )}
        </tbody>
        {hasAggregates && (
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/40 font-medium">
              <td className="px-2 py-1.5 text-xs text-muted-foreground">Σ</td>
              {doc.columns.map((col) => {
                const kind = doc.aggregates?.[col.id];
                const value = kind && kind !== 'none' ? computeAggregate(doc, col.id, kind) : null;
                return (
                  <td key={col.id} className="border-l border-border px-2 py-1.5 text-xs">
                    {value !== null ? (
                      <span>
                        <span className="text-muted-foreground">{AGG_LABEL[kind!].toLowerCase()} </span>
                        {displayValue(value, col.type === 'formula' ? { ...col, type: 'number' } : col)}
                      </span>
                    ) : null}
                  </td>
                );
              })}
              <td aria-hidden />
            </tr>
          </tfoot>
        )}
      </table>

      <div className="px-2 py-2">
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onChange(addRow(doc).doc)}>
          <Plus /> Add row
        </Button>
      </div>
    </div>
  );
}

function HeaderCell({
  col,
  aggregate,
  sortDir,
  onSort,
  onClearSort,
  onRename,
  onType,
  onAggregate,
  onInsertRight,
  onDelete,
}: {
  col: Column;
  aggregate: AggregateKind;
  sortDir: 'asc' | 'desc' | null;
  onSort: (dir: 'asc' | 'desc') => void;
  onClearSort: () => void;
  onRename: (name: string) => void;
  onType: (type: ColumnType) => void;
  onAggregate: (kind: AggregateKind) => void;
  onInsertRight: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(col.name);
  const TypeIcon = TYPE_ICON[col.type];
  const AggIcon = aggregate !== 'none' ? AGG_ICON[aggregate] : null;
  return (
    <span className="flex w-full items-center gap-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== col.name && onRename(name.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus:ring-0"
        aria-label="Column name"
      />
      {sortDir === 'asc' && <ArrowUp className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
      {sortDir === 'desc' && <ArrowDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
      {AggIcon && (
        <span className="shrink-0" title={`Total: ${AGG_LABEL[aggregate]}`}>
          <AggIcon className="size-3 text-muted-foreground" aria-label={`Total: ${AGG_LABEL[aggregate]}`} />
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={`Column type: ${TYPE_LABEL[col.type]} — open options`}
            title={`${TYPE_LABEL[col.type]} column — options`}
          >
            <TypeIcon className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{TYPE_LABEL[col.type]} column</DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={MENU_SUBTRIGGER}><Type className="mr-2 size-3.5" /> Type</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={col.type} onValueChange={(v) => onType(v as ColumnType)}>
                {COLUMN_TYPES.map((t) => {
                  const Icon = TYPE_ICON[t];
                  return (
                    <DropdownMenuRadioItem key={t} value={t} className={MENU_RADIO_ITEM}>
                      <Icon className="mr-2 size-3.5" aria-hidden />
                      {TYPE_LABEL[t]}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={MENU_SUBTRIGGER}><Sigma className="mr-2 size-3.5" /> Total</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={aggregate} onValueChange={(v) => onAggregate(v as AggregateKind)}>
                {AGGREGATE_KINDS.map((k) => {
                  const Icon = AGG_ICON[k];
                  return (
                    <DropdownMenuRadioItem key={k} value={k} className={MENU_RADIO_ITEM}>
                      <Icon className="mr-2 size-3.5" aria-hidden />
                      {AGG_LABEL[k]}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onSort('asc')}><ArrowUp className="mr-2 size-3.5" /> Sort ascending</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort('desc')}><ArrowDown className="mr-2 size-3.5" /> Sort descending</DropdownMenuItem>
          {sortDir && <DropdownMenuItem onClick={onClearSort}><ChevronsUpDown className="mr-2 size-3.5" /> Clear sort</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onInsertRight}><ListPlus className="mr-2 size-3.5" /> Insert column right</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
            <Trash2 className="mr-2 size-3.5" /> Delete column
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

const CELL_INPUT = 'w-full border-0 bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-muted/50 focus:ring-0';

// Type/Total menu items: mark the current choice in the theme's primary (not a
// saturated accent fill that hides the label), and keep the keyboard/hover
// highlight neutral + readable. Theme tokens only.
const MENU_RADIO_ITEM =
  'focus:bg-muted focus:text-foreground data-[state=checked]:font-semibold data-[state=checked]:text-primary';

// The shared SubTrigger flips its background to accent on hover/open but (unlike
// a regular Item) never flips the TEXT to accent-foreground, so the label can be
// unreadable on a saturated accent. Pair them, matching the Sort/Insert items.
const MENU_SUBTRIGGER = 'focus:text-accent-foreground data-[state=open]:text-accent-foreground';

function EditableCell({
  col,
  value,
  rawValue,
  onSet,
  onApplyOption,
}: {
  col: Column;
  value: CellValue; // resolved (formula columns computed)
  rawValue: CellValue; // stored
  onSet: (v: CellValue) => void;
  /** Set the cell, optionally creating a new select/multiselect option first. */
  onApplyOption: (p: { value: CellValue; newOption?: string }) => void;
}) {
  if (col.type === 'formula') {
    return <span className="block px-2 py-1.5 text-sm text-muted-foreground">{displayValue(value, col)}</span>;
  }
  if (col.type === 'checkbox') {
    return (
      <span className="flex items-center justify-center py-1.5">
        <Checkbox checked={Boolean(rawValue)} onCheckedChange={(c) => onSet(c === true)} aria-label={col.name} />
      </span>
    );
  }
  if (col.type === 'select' || col.type === 'multiselect') {
    return <OptionCell col={col} rawValue={rawValue} multi={col.type === 'multiselect'} apply={onApplyOption} />;
  }
  if (col.type === 'date') {
    return <DateCell col={col} rawValue={rawValue} onSet={onSet} />;
  }
  if (col.type === 'datetime') {
    return <DateTimeCell col={col} rawValue={rawValue} onSet={onSet} />;
  }
  // text / number / currency / percent / url
  return <TextCell col={col} rawValue={rawValue} onSet={onSet} />;
}

// ── date helpers ──────────────────────────────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, '0');
function parseDateValue(v: CellValue): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  // date-only 'YYYY-MM-DD' → local midnight; a full ISO string → as stored.
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const formatDateOnly = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Date-only cell — the shadcn Calendar in a Popover (no native input). */
function DateCell({ col, rawValue, onSet }: { col: Column; rawValue: CellValue; onSet: (v: CellValue) => void }) {
  const [open, setOpen] = useState(false);
  const date = parseDateValue(rawValue);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm outline-none hover:bg-muted/40" aria-label={col.name}>
          <Calendar className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {date ? (
            <span className="truncate">{date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {date && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSet(null); }}
              className="ml-auto text-muted-foreground hover:text-foreground"
              aria-label="Clear date"
            >
              <X className="size-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <CalendarPicker
          mode="single"
          selected={date ?? undefined}
          onSelect={(d) => { onSet(d ? formatDateOnly(d) : null); setOpen(false); }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

/** Date + time cell — the shared DateTimePicker (Calendar + time field). */
function DateTimeCell({ col, rawValue, onSet }: { col: Column; rawValue: CellValue; onSet: (v: CellValue) => void }) {
  const date = parseDateValue(rawValue);
  return (
    <div className="px-1.5 py-1" aria-label={col.name}>
      <DateTimePicker value={date} onChange={(d) => onSet(d ? d.toISOString() : null)} placeholder="—" clearable />
    </div>
  );
}

/** Select / multi-select cell — a Command combobox over the column's options,
 *  with inline "Create '<value>'" (which appends the option to the column AND
 *  selects it via `apply`). Single picks one label; multi toggles a string[]. */
function OptionCell({
  col,
  rawValue,
  multi,
  apply,
}: {
  col: Column;
  rawValue: CellValue;
  multi: boolean;
  apply: (p: { value: CellValue; newOption?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = col.options ?? [];
  const selected: string[] = multi
    ? Array.isArray(rawValue) ? rawValue.map(String) : []
    : typeof rawValue === 'string' && rawValue ? [rawValue] : [];

  const q = query.trim();
  const ql = q.toLowerCase();
  const filtered = ql ? options.filter((o) => o.label.toLowerCase().includes(ql)) : options;
  const canCreate = q.length > 0 && !options.some((o) => o.label.toLowerCase() === ql);

  const choose = (label: string) => {
    if (multi) {
      const next = selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label];
      apply({ value: next });
      setQuery('');
    } else {
      apply({ value: label });
      setQuery('');
      setOpen(false);
    }
  };
  const create = () => {
    if (!q) return;
    if (multi) {
      apply({ value: [...selected, q], newOption: q });
      setQuery('');
    } else {
      apply({ value: q, newOption: q });
      setQuery('');
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <button type="button" className="flex min-h-[2.1rem] w-full items-center gap-1 px-2 py-1 text-left text-sm outline-none hover:bg-muted/40" aria-label={col.name}>
          {selected.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : multi ? (
            <span className="flex flex-wrap gap-1">
              {selected.map((s) => <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>)}
            </span>
          ) : (
            <span className="truncate">{selected[0]}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={multi ? 'Search or add…' : 'Select or add…'} />
          <CommandList>
            {filtered.length === 0 && !canCreate && <CommandEmpty>Type to add an option.</CommandEmpty>}
            <CommandGroup>
              {filtered.map((o) => (
                <CommandItem key={o.id} value={o.label} onSelect={() => choose(o.label)}>
                  <Check className={cn('mr-2 size-3.5', selected.includes(o.label) ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  {o.label}
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem value={`__create__${q}`} onSelect={create}>
                  <Plus className="mr-2 size-3.5" aria-hidden /> Create “{q}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A text-like cell that keeps its value in LOCAL state and only writes back to
 * the doc on blur / Enter. Typing therefore never re-renders the grid (no focus
 * loss) and never fires the per-keystroke draft autosave — the cell commits once
 * when you leave it. Syncs from the doc only while unfocused (so an external
 * edit — the agent, a type change — still reflects).
 */
function TextCell({ col, rawValue, onSet }: { col: Column; rawValue: CellValue; onSet: (v: CellValue) => void }) {
  const isNumeric = col.type === 'number' || col.type === 'currency' || col.type === 'percent';
  const external = rawValue == null ? '' : Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  const [local, setLocal] = useState(external);
  const focused = useRef(false);

  // Adopt external changes only when the user isn't editing this cell.
  useEffect(() => {
    if (!focused.current) setLocal(external);
  }, [external]);

  const commit = () => {
    focused.current = false;
    const next = coerceCell(local, col.type);
    const nextStr = next == null ? '' : Array.isArray(next) ? next.join(', ') : String(next);
    if (nextStr !== external) onSet(next);
  };

  return (
    <input
      value={local}
      inputMode={isNumeric ? 'decimal' : undefined}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setLocal(external); focused.current = false; (e.target as HTMLInputElement).blur(); }
      }}
      placeholder={isNumeric ? '0' : ''}
      className={cn(CELL_INPUT, isNumeric && 'text-right tabular-nums')}
      aria-label={col.name}
    />
  );
}
