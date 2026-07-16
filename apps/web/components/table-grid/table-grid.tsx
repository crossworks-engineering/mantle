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
import { useVirtualizer } from '@tanstack/react-virtual';
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
  Link2,
  List,
  ListOrdered,
  ListPlus,
  Maximize2,
  Unlink,
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
  ArrowUpRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { apiFetch } from '@/lib/api-fetch';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  storageType,
  updateColumn,
  type AggregateKind,
  type CellValue,
  type Column,
  type ColumnType,
  type RefMode,
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
  reference: 'Reference',
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
  reference: ArrowUpRight,
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

export function TableGrid({
  doc,
  onChange,
  tableId,
  tabs,
  activeTabId,
}: {
  doc: TableDoc;
  onChange: (next: TableDoc) => void;
  /** Enables server-backed cells (reference dropdowns fetch their option
   *  list from the workbook). Optional — cells degrade to text without it. */
  tableId?: string;
  /** Workbook tabs, for the header's "Reference…" source picker. Absent on
   *  legacy JSONB tables (single-grid, no reference columns). */
  tabs?: { id: string; name: string }[];
  /** The tab this grid is showing — so the picker can exclude the column
   *  itself when the source tab is this one (self-reference guard). */
  activeTabId?: string;
}) {
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
    .map((c) => `${c.id}:${c.type}:${c.name}:${c.formula ?? ''}:${(c.options ?? []).map((o) => o.label).join(',')}:${JSON.stringify(c.format ?? {})}:${c.ref ? `${c.ref.tabId}/${c.ref.columnId}` : ''}`)
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
          // Retype through the standard menu is never 'reference' — it UNLINKS:
          // clear ref + refMode so a linked column becomes a clean plain column.
          onType={(type) => onChangeRef.current(updateColumn(docRef.current, col.id, { type, ref: undefined, refMode: undefined }))}
          // Link / change source (dialog): new links default to select; a
          // source change on an already-linked column keeps its mode.
          onReference={(ref) =>
            onChangeRef.current(
              updateColumn(docRef.current, col.id, {
                type: 'reference',
                ref,
                refMode: col.type === 'reference' ? (col.refMode ?? 'select') : 'select',
              }),
            )
          }
          // Switch linked mode (🔗 menu) — keeps the ref.
          onReferenceMode={(refMode) => onChangeRef.current(updateColumn(docRef.current, col.id, { refMode }))}
          // Delete link (🔗 menu): keep values, drop the link. A linked-checkbox
          // stays a checkbox (boolean); a linked-select becomes plain text.
          onDeleteLink={() =>
            onChangeRef.current(
              updateColumn(docRef.current, col.id, {
                type: col.refMode === 'checkbox' ? 'checkbox' : 'text',
                ref: undefined,
                refMode: undefined,
              }),
            )
          }
          onAggregate={(kind) => onChangeRef.current(setAggregate(docRef.current, col.id, kind))}
          onInsertRight={() => onChangeRef.current(addColumn(docRef.current, { name: 'New column', type: 'text' }, col.id).doc)}
          onDelete={() => onChangeRef.current(deleteColumn(docRef.current, col.id))}
          tableId={tableId}
          tabs={tabs}
          activeTabId={activeTabId}
        />
      ),
      cell: (info) => (
        <EditableCell
          col={col}
          tableId={tableId}
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
  }, [structureKey, tableId]);

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

  // Row virtualization — only the rows in (and just around) the viewport are
  // mounted. A 3000-row grid is ~54k stateful cells; rendering them all froze
  // the tab for seconds on open. The scroll container is this component's root;
  // off-screen rows are replaced by two spacer <tr>s carrying their height, so
  // the scrollbar, sort, and footer totals all still see the full set.
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
    getItemKey: (index) => rows[index]!.id,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const padTop = virtualRows.length ? virtualRows[0]!.start : 0;
  const padBottom = virtualRows.length ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end : 0;
  const colSpanAll = doc.columns.length + 2;

  return (
    <div ref={scrollRef} className="h-full overflow-auto scrollbar-thin">
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
          {padTop > 0 && (
            <tr aria-hidden>
              <td colSpan={colSpanAll} style={{ height: padTop }} className="p-0" />
            </tr>
          )}
          {virtualRows.map((vr) => {
            const row = rows[vr.index]!;
            return (
              <tr
                key={row.id}
                data-index={vr.index}
                ref={rowVirtualizer.measureElement}
                className="group border-b border-border hover:bg-muted/40"
              >
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
            );
          })}
          {padBottom > 0 && (
            <tr aria-hidden>
              <td colSpan={colSpanAll} style={{ height: padBottom }} className="p-0" />
            </tr>
          )}
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
  onReference,
  onReferenceMode,
  onDeleteLink,
  onAggregate,
  onInsertRight,
  onDelete,
  tableId,
  tabs,
  activeTabId,
}: {
  col: Column;
  aggregate: AggregateKind;
  sortDir: 'asc' | 'desc' | null;
  onSort: (dir: 'asc' | 'desc') => void;
  onClearSort: () => void;
  onRename: (name: string) => void;
  onType: (type: ColumnType) => void;
  onReference: (ref: { tabId: string; columnId: string }) => void;
  onReferenceMode: (mode: RefMode) => void;
  onDeleteLink: () => void;
  onAggregate: (kind: AggregateKind) => void;
  onInsertRight: () => void;
  onDelete: () => void;
  tableId?: string;
  tabs?: { id: string; name: string }[];
  activeTabId?: string;
}) {
  const [name, setName] = useState(col.name);
  const [refDlgOpen, setRefDlgOpen] = useState(false);
  // Reference columns need a workbook to point into — offered only when we
  // have the tab list + a server-backed table (legacy JSONB tables don't).
  const canReference = !!tableId && !!tabs && tabs.length > 0;
  const linked = col.type === 'reference' && !!col.ref;
  const linkMode: RefMode = col.refMode ?? 'select';
  // A linked column presents as its mode (select→list, checkbox→check); the
  // 🔗 to its left is what says "linked".
  const TypeIcon = TYPE_ICON[linked ? storageType(col) : col.type];
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
      {/* Linked-column indicator + its own menu, left of the type menu. */}
      {linked && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 text-muted-foreground"
              aria-label="Linked column — options"
              title="Linked column"
            >
              <Link2 className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Linked column</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={MENU_SUBTRIGGER}><Link2 className="mr-2 size-3.5" /> Mode</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={linkMode} onValueChange={(v) => onReferenceMode(v as RefMode)}>
                  <DropdownMenuRadioItem value="select" className={MENU_RADIO_ITEM}>
                    <List className="mr-2 size-3.5" aria-hidden /> Select (one value)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="checkbox" className={MENU_RADIO_ITEM}>
                    <SquareCheck className="mr-2 size-3.5" aria-hidden /> Checkbox
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {canReference && (
              <DropdownMenuItem className={MENU_RADIO_ITEM} onSelect={() => setRefDlgOpen(true)}>
                <ArrowUpRight className="mr-2 size-3.5" aria-hidden /> Change source…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDeleteLink}>
              <Unlink className="mr-2 size-3.5" /> Delete link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
                {COLUMN_TYPES.filter((t) => t !== 'reference').map((t) => {
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
          {canReference && !linked && (
            <DropdownMenuItem className={MENU_RADIO_ITEM} onSelect={() => setRefDlgOpen(true)}>
              <Link2 className="mr-2 size-3.5" aria-hidden />
              Link column…
            </DropdownMenuItem>
          )}
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
      {canReference && (
        <ReferenceColumnDialog
          open={refDlgOpen}
          onOpenChange={setRefDlgOpen}
          tableId={tableId!}
          tabs={tabs!}
          activeTabId={activeTabId}
          currentColumnId={col.id}
          currentRef={col.ref}
          onConfirm={(ref) => {
            onReference(ref);
            setRefDlgOpen(false);
          }}
        />
      )}
    </span>
  );
}

/** Pick a source (tab, column) to turn this column into a cross-tab reference
 *  (Tables v2.1). The engine validates the choice again on save; this just
 *  spares the assistant/tool round-trip. Source columns are fetched per tab
 *  (draft-aware) and exclude formula columns + this column itself. */
function ReferenceColumnDialog({
  open,
  onOpenChange,
  tableId,
  tabs,
  activeTabId,
  currentColumnId,
  currentRef,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  tabs: { id: string; name: string }[];
  activeTabId?: string;
  currentColumnId: string;
  currentRef?: { tabId: string; columnId: string };
  onConfirm: (ref: { tabId: string; columnId: string }) => void;
}) {
  const [tabId, setTabId] = useState<string | undefined>(currentRef?.tabId);
  const [cols, setCols] = useState<{ id: string; name: string; type: string }[] | null>(null);
  const [colId, setColId] = useState<string | undefined>(currentRef?.columnId);
  const [loading, setLoading] = useState(false);

  // Reset to the current ref each time the dialog opens.
  useEffect(() => {
    if (open) {
      setTabId(currentRef?.tabId);
      setColId(currentRef?.columnId);
      setCols(null);
    }
  }, [open, currentRef?.tabId, currentRef?.columnId]);

  // Load the chosen tab's columns (draft-aware); exclude formula columns and
  // this column itself (self-reference is rejected by the engine anyway).
  useEffect(() => {
    if (!open || !tabId) return;
    let cancelled = false;
    setLoading(true);
    setCols(null);
    void (async () => {
      try {
        const j = await apiFetch<{ table: { data?: { columns?: { id: string; name: string; type: string }[] }; draft?: { columns?: { id: string; name: string; type: string }[] } } }>(
          `/api/tables/${tableId}?tab=${encodeURIComponent(tabId)}`,
        );
        const source = j.table.draft?.columns ?? j.table.data?.columns ?? [];
        const usable = source.filter(
          (c) => c.type !== 'formula' && !(tabId === activeTabId && c.id === currentColumnId),
        );
        if (!cancelled) setCols(usable);
      } catch {
        if (!cancelled) setCols([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tabId, tableId, activeTabId, currentColumnId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{currentRef ? 'Change linked source' : 'Link column'}</DialogTitle>
          <DialogDescription>
            This column offers values from another tab’s column — picked values are copied as plain text (a convenience
            picker, not a live link).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Source tab</span>
            <Command className="rounded border border-border">
              <CommandList className="max-h-40">
                <CommandEmpty>No tabs</CommandEmpty>
                <CommandGroup>
                  {tabs.map((t) => (
                    <CommandItem
                      key={t.id}
                      value={t.name}
                      onSelect={() => {
                        setTabId(t.id);
                        setColId(undefined);
                      }}
                    >
                      <Check className={cn('mr-2 size-3.5', tabId === t.id ? 'opacity-100' : 'opacity-0')} />
                      {t.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Source column</span>
            {!tabId ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Pick a tab first.</p>
            ) : loading ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Loading columns…</p>
            ) : (cols ?? []).length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">No linkable columns on this tab.</p>
            ) : (
              <Command className="rounded border border-border">
                <CommandInput placeholder="Search columns…" />
                <CommandList className="max-h-40">
                  <CommandEmpty>No match</CommandEmpty>
                  <CommandGroup>
                    {(cols ?? []).map((c) => (
                      <CommandItem key={c.id} value={c.name} onSelect={() => setColId(c.id)}>
                        <Check className={cn('mr-2 size-3.5', colId === c.id ? 'opacity-100' : 'opacity-0')} />
                        {c.name}
                        <span className="ml-auto text-xs text-muted-foreground">{c.type}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!tabId || !colId}
              onClick={() => tabId && colId && onConfirm({ tabId, columnId: colId })}
            >
              {currentRef ? 'Change source' : 'Link column'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  tableId,
}: {
  col: Column;
  value: CellValue; // resolved (formula columns computed)
  rawValue: CellValue; // stored
  onSet: (v: CellValue) => void;
  /** Set the cell, optionally creating a new select/multiselect option first. */
  onApplyOption: (p: { value: CellValue; newOption?: string }) => void;
  tableId?: string;
}) {
  if (col.type === 'formula') {
    return <span className="block px-2 py-1.5 text-sm text-muted-foreground">{displayValue(value, col)}</span>;
  }
  // A linked-CHECKBOX is a real boolean (the link only borrows the source's
  // label); render it like any checkbox. A linked-SELECT is the source-values
  // dropdown. Both keyed on refMode (v2.2).
  if (col.type === 'checkbox' || (col.type === 'reference' && col.refMode === 'checkbox')) {
    return (
      <span className="flex items-center justify-center py-1.5">
        <Checkbox checked={Boolean(rawValue)} onCheckedChange={(c) => onSet(c === true)} aria-label={col.name} />
      </span>
    );
  }
  if (col.type === 'select' || col.type === 'multiselect') {
    return <OptionCell col={col} rawValue={rawValue} multi={col.type === 'multiselect'} apply={onApplyOption} />;
  }
  if (col.type === 'reference' && col.ref && tableId) {
    return <ReferenceCell col={col} rawValue={rawValue} onSet={onSet} tableId={tableId} />;
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
/** Reference cell (v2.1 P4): a combobox whose options are the DISTINCT values
 *  of the source tab's column, fetched lazily on open (draft-first). Free text
 *  is allowed — Excel's "warn, don't block" model; the profile flags dangling
 *  values. */
function ReferenceCell({
  col,
  rawValue,
  onSet,
  tableId,
}: {
  col: Column;
  rawValue: CellValue;
  onSet: (v: CellValue) => void;
  tableId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<string[] | null>(null);
  const current = typeof rawValue === 'string' ? rawValue : rawValue == null ? '' : String(rawValue);

  // Re-pointing the reference source (via the header dialog) changes col.ref
  // while this cell instance stays mounted — drop the cached option list so
  // the next open refetches from the new source (audit).
  const refKey = col.ref ? `${col.ref.tabId}/${col.ref.columnId}` : '';
  useEffect(() => {
    setOptions(null);
  }, [refKey]);

  useEffect(() => {
    if (!open || options !== null || !col.ref) return;
    let cancelled = false;
    void (async () => {
      try {
        const j = await apiFetch<{ values: string[] }>(
          `/api/tables/${tableId}/rows?distinct=${encodeURIComponent(col.ref!.columnId)}&tab=${encodeURIComponent(col.ref!.tabId)}&draft=1&limit=200`,
        );
        if (!cancelled) setOptions(j.values);
      } catch {
        if (!cancelled) setOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, options, col.ref, tableId]);

  const q = query.trim();
  const ql = q.toLowerCase();
  const filtered = (options ?? []).filter((v) => !ql || v.toLowerCase().includes(ql));
  const canFreeText = q.length > 0 && !(options ?? []).some((v) => v.toLowerCase() === ql);

  const choose = (v: string) => {
    onSet(v);
    setQuery('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-h-[2.1rem] w-full items-center gap-1 px-2 py-1 text-left text-sm outline-none hover:bg-muted/40"
          aria-label={col.name}
        >
          {current ? <span className="truncate">{current}</span> : <span className="text-muted-foreground">—</span>}
          <ChevronsUpDown className="ml-auto size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q) choose(q);
          }}
          placeholder="Search values…"
          className="mb-1 w-full rounded-sm border border-border bg-transparent px-2 py-1 text-sm outline-none focus:ring-0"
          aria-label={`Search ${col.name} values`}
        />
        <div className="max-h-56 overflow-y-auto">
          {options === null ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
          ) : (
            <>
              {current && (
                <button type="button" className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => choose('')}>
                  <X className="mr-2 size-3.5" aria-hidden /> Clear
                </button>
              )}
              {filtered.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => choose(v)}
                >
                  <span className="truncate">{v}</span>
                  {v === current && <Check className="ml-auto size-3.5 shrink-0 text-primary" aria-hidden />}
                </button>
              ))}
              {filtered.length === 0 && !canFreeText && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No values</div>
              )}
              {canFreeText && (
                <button type="button" className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => choose(q)}>
                  <ListPlus className="mr-2 size-3.5 shrink-0" aria-hidden />
                  Use “{q}”
                </button>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TextCell({ col, rawValue, onSet }: { col: Column; rawValue: CellValue; onSet: (v: CellValue) => void }) {
  const isNumeric = col.type === 'number' || col.type === 'currency' || col.type === 'percent';
  // Long free text (text/url) gets an Excel-style expander: the row height is
  // fixed (the grid virtualizes on it), so the whole value can't grow the cell
  // in place — instead a portal popover shows/edits the full string without
  // touching layout. Numeric/short types keep the plain inline input.
  const expandable = col.type === 'text' || col.type === 'url';
  const external = rawValue == null ? '' : Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  const [local, setLocal] = useState(external);
  const [expanded, setExpanded] = useState(false);
  const editing = useRef(false);
  // commit() reads the value from a ref, never from `local` state: setLocal is
  // async, so a cancel that did `setLocal(external)` and then blurred would
  // still see the EDITED value in the closure and save it — Esc "cancel" would
  // silently persist (audit). The ref is the single source of truth for commit.
  const valueRef = useRef(local);
  valueRef.current = local;

  // Adopt external changes only when the user isn't editing this cell.
  useEffect(() => {
    if (!editing.current) setLocal(external);
  }, [external]);

  const commit = () => {
    editing.current = false;
    const next = coerceCell(valueRef.current, col.type);
    const nextStr = next == null ? '' : Array.isArray(next) ? next.join(', ') : String(next);
    if (nextStr !== external) onSet(next);
  };
  // Revert to the stored value — point the ref at `external` FIRST so any
  // commit that races the state update (blur/close) is a no-op.
  const cancel = () => {
    editing.current = false;
    valueRef.current = external;
    setLocal(external);
  };

  const input = (
    <input
      value={local}
      inputMode={isNumeric ? 'decimal' : undefined}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { cancel(); (e.target as HTMLInputElement).blur(); }
      }}
      placeholder={isNumeric ? '0' : ''}
      className={cn(CELL_INPUT, isNumeric && 'text-right tabular-nums', expandable && 'pr-7')}
      aria-label={col.name}
    />
  );

  if (!expandable) return input;

  return (
    <div className="group/cell relative flex items-center">
      {input}
      <Popover
        open={expanded}
        onOpenChange={(o) => {
          setExpanded(o);
          // Closing the popover (outside-click, Enter, or after Esc's cancel)
          // is the single commit point for the expanded editor — cancel() has
          // already pointed valueRef at `external`, so a cancelled close saves
          // nothing.
          if (!o) commit();
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => { editing.current = true; setExpanded(true); }}
            title="Expand cell"
            aria-label="Expand cell"
            className="absolute right-1 rounded bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/cell:opacity-100 group-focus-within/cell:opacity-100 data-[state=open]:opacity-100"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[22rem] p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{col.name}</div>
          <textarea
            autoFocus
            value={local}
            onFocus={() => { editing.current = true; }}
            onChange={(e) => setLocal(e.target.value)}
            // No onBlur commit: the popover close (onOpenChange) is the one
            // commit point, so there's no blur-vs-close double-save race.
            onKeyDown={(e) => {
              if (e.key === 'Escape') { cancel(); setExpanded(false); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) setExpanded(false);
            }}
            rows={Math.min(14, Math.max(3, local.split('\n').length + 1))}
            className="max-h-[60vh] w-full resize-y rounded border border-border bg-background p-2 text-sm outline-none focus:ring-0"
            aria-label={`${col.name} (expanded)`}
          />
          <div className="mt-1 text-right text-[11px] text-muted-foreground">⌘↵ save · Esc cancel</div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
