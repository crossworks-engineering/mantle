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
  ArrowUp,
  ChevronsUpDown,
  ListPlus,
  Plus,
  Sigma,
  Trash2,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
            <tr key={row.id} className="group border-b border-border hover:bg-accent/30">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground" aria-label="Column options">
            <ChevronsUpDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{TYPE_LABEL[col.type]} column</DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Type className="mr-2 size-3.5" /> Type</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={col.type} onValueChange={(v) => onType(v as ColumnType)}>
                {COLUMN_TYPES.map((t) => (
                  <DropdownMenuRadioItem key={t} value={t}>{TYPE_LABEL[t]}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Sigma className="mr-2 size-3.5" /> Total</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={aggregate} onValueChange={(v) => onAggregate(v as AggregateKind)}>
                {AGGREGATE_KINDS.map((k) => (
                  <DropdownMenuRadioItem key={k} value={k}>{AGG_LABEL[k]}</DropdownMenuRadioItem>
                ))}
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

const CELL_INPUT = 'w-full border-0 bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-0';

function EditableCell({
  col,
  value,
  rawValue,
  onSet,
}: {
  col: Column;
  value: CellValue; // resolved (formula columns computed)
  rawValue: CellValue; // stored
  onSet: (v: CellValue) => void;
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
  if (col.type === 'select') {
    const options = col.options ?? [];
    return (
      <Select value={(rawValue as string) ?? ''} onValueChange={(v) => onSet(v || null)}>
        <SelectTrigger className="h-auto border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus:ring-0">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.label}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (col.type === 'date' || col.type === 'datetime') {
    const iso = typeof rawValue === 'string' ? rawValue : '';
    const v = col.type === 'date' ? iso.slice(0, 10) : iso.slice(0, 16);
    return (
      <input
        type={col.type === 'date' ? 'date' : 'datetime-local'}
        value={v}
        onChange={(e) => onSet(e.target.value || null)}
        className={CELL_INPUT}
        aria-label={col.name}
      />
    );
  }
  // text / number / currency / percent / url / multiselect
  return <TextCell col={col} rawValue={rawValue} onSet={onSet} />;
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
