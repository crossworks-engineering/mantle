'use client';

import { useMemo, useState } from 'react';
import katex from 'katex';
import { AlertTriangle, Sigma } from 'lucide-react';
import type { CoverageGap, FormulaSpec, FormulaValue, TraceStep } from '@server/lib/formulas';
import { Badge } from '@mantle/web-ui/ui/badge';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { Separator } from '@mantle/web-ui/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mantle/web-ui/ui/table';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { apiSend } from '@mantle/web-ui/api-fetch';
import { cn } from '@mantle/web-ui/lib/utils';

export type FormulaRow = {
  id: string;
  title: string;
  spec: FormulaSpec;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

type EvalResponse =
  | { ok: true; value: FormulaValue; trace: TraceStep[] }
  | { ok: false; error: string; trace: TraceStep[] };

function citation(spec: FormulaSpec): string | null {
  const s = spec.source;
  if (!s) return null;
  const head = [s.standard, s.part ? `Part ${s.part}` : '', s.edition ? `(${s.edition})` : '']
    .filter(Boolean)
    .join(' ');
  const sections = s.sections?.length ? `, §${s.sections.join(', §')}` : '';
  const tables = s.tables?.length ? `, Tables ${s.tables.join(', ')}` : '';
  return `${head}${sections}${tables}`.trim() || null;
}

/** Renders the author-supplied `latex` when present, else the literal
 *  expression. Never derives one from the other: `expression` is what is
 *  computed and `latex` is only how it is drawn. */
function Equation({ latex, expression }: { latex?: string; expression: string }) {
  const html = useMemo(() => {
    if (!latex) return null;
    try {
      // `trust: false` (KaTeX's default, pinned here because the output goes
      // through dangerouslySetInnerHTML) disables \href, \url and
      // \includegraphics — a spec authored by an agent from a pasted document
      // must not be able to inject a link or fetch a remote asset.
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        trust: false,
      });
    } catch {
      return null;
    }
  }, [latex]);
  if (html) {
    return (
      <div
        className="overflow-x-auto py-2 scrollbar-thin"
        // KaTeX output, generated from the spec's own display string.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground scrollbar-thin">
      <code>{expression}</code>
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function valueOf(raw: string): FormulaValue {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && /^[-+]?[0-9.eE+]+$/.test(t) ? n : t;
}

export function FormulaDetail({
  formula,
  coverageGaps,
}: {
  formula: FormulaRow;
  coverageGaps: CoverageGap[];
}) {
  const spec = formula.spec;
  const cite = citation(spec);

  const targets = useMemo(
    () => [
      ...spec.expressions.map((e) => ({ id: e.id, kind: 'expression' })),
      ...spec.piecewise.map((p) => ({ id: p.id, kind: 'branch' })),
      ...spec.lookups.map((l) => ({ id: l.id, kind: 'lookup' })),
    ],
    [spec],
  );

  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<EvalResponse | null>(null);
  const [running, setRunning] = useState(false);

  // Everything the user may supply: declared inputs, plus the key symbols of
  // every lookup (which are enums rather than variables).
  const inputFields = useMemo(() => {
    const fields = spec.variables
      .filter((v) => v.role === 'input')
      .map((v) => ({ symbol: v.symbol, label: v.name ?? v.symbol, unit: v.unit ?? null }));
    const seen = new Set(fields.map((f) => f.symbol));
    for (const lookup of spec.lookups) {
      for (const key of lookup.keys) {
        if (!seen.has(key)) {
          seen.add(key);
          fields.push({ symbol: key, label: key, unit: null });
        }
      }
    }
    return fields;
  }, [spec]);

  async function run() {
    if (!target) return;
    setRunning(true);
    try {
      const supplied: Record<string, FormulaValue> = {};
      for (const [k, v] of Object.entries(inputs)) {
        const parsed = valueOf(v);
        if (parsed !== null) supplied[k] = parsed;
      }
      const res = await apiSend<EvalResponse>(`/api/formulas/${formula.id}/evaluate`, 'POST', {
        target,
        inputs: supplied,
      });
      setResult(res);
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : 'evaluation failed',
        trace: [],
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Sigma className="size-4 text-muted-foreground" />
          <h2 className="truncate text-base font-semibold text-foreground">{formula.title}</h2>
        </div>
        {cite ? <p className="mt-1 text-xs text-muted-foreground">{cite}</p> : null}
        {spec.unitSystem ? (
          <Badge variant="secondary" className="mt-2">
            {spec.unitSystem}
          </Badge>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto scrollbar-thin px-6 py-5">
        {coverageGaps.length > 0 ? (
          <div className="flex gap-3 rounded-md border border-border bg-muted/50 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-xs">
              <p className="font-medium text-foreground">
                The source leaves {coverageGaps.length} combination
                {coverageGaps.length === 1 ? '' : 's'} unspecified
              </p>
              <p className="text-muted-foreground">
                These keys are declared legal but have no row. Evaluating one is an error rather
                than a zero.
              </p>
              <ul className="text-muted-foreground">
                {coverageGaps.slice(0, 12).map((gap, i) => (
                  <li key={i}>
                    <code>{gap.lookupId}</code>:{' '}
                    {Object.entries(gap.key)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {spec.expressions.length > 0 ? (
          <Section title="Equations">
            <div className="space-y-4">
              {spec.expressions.map((e) => (
                <div key={e.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-medium text-foreground">{e.id}</code>
                    {e.equation ? (
                      <Badge variant="outline" className="text-[10px]">
                        Eq {e.equation}
                      </Badge>
                    ) : null}
                    {e.resultSymbol ? (
                      <span className="text-xs text-muted-foreground">
                        → {e.resultSymbol}
                        {e.unit ? ` [${e.unit}]` : ''}
                      </span>
                    ) : null}
                  </div>
                  <Equation latex={e.latex} expression={e.expression} />
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {spec.piecewise.length > 0 ? (
          <Section title="Conditional selection">
            {spec.piecewise.map((p) => (
              <div key={p.id} className="space-y-1 text-xs">
                <code className="font-medium text-foreground">{p.id}</code>
                <ul className="space-y-1 text-muted-foreground">
                  {p.cases.map((c, i) => (
                    <li key={i}>
                      {c.label ? <span className="text-foreground">{c.label}</span> : null} when{' '}
                      <code>{c.when}</code> use <code>{c.use}</code>
                    </li>
                  ))}
                  {p.otherwise ? (
                    <li>
                      otherwise use <code>{p.otherwise}</code>
                    </li>
                  ) : null}
                </ul>
              </div>
            ))}
          </Section>
        ) : null}

        {spec.variables.length > 0 ? (
          <Section title="Variables">
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spec.variables.map((v) => (
                    <TableRow key={v.symbol}>
                      <TableCell className="font-mono text-xs">{v.symbol}</TableCell>
                      <TableCell className="text-xs">{v.name ?? ''}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {v.expression ?? (v.value !== undefined ? String(v.value) : '')}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {v.unit ?? ''}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={v.role === 'input' ? 'default' : 'secondary'}
                          className="text-[10px]"
                        >
                          {v.role}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        ) : null}

        {spec.lookups.map((lookup) => (
          <Section key={lookup.id} title={lookup.name ?? lookup.id}>
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    {[...lookup.keys, lookup.result].map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lookup.rows.map((row, i) => (
                    <TableRow key={i}>
                      {[...lookup.keys, lookup.result].map((c) => (
                        <TableCell key={c} className="text-xs">
                          {row[c] === null || row[c] === undefined ? '' : String(row[c])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        ))}

        {spec.classifications.map((c) => (
          <Section key={c.id} title={c.id}>
            <dl className="space-y-2 text-xs">
              {c.domain.map((value) => (
                <div key={value} className="flex gap-3">
                  <dt className="w-6 shrink-0 font-mono font-medium text-foreground">{value}</dt>
                  <dd className="text-muted-foreground">{c.criteria[value]}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ))}

        {spec.notes && Object.keys(spec.notes).length > 0 ? (
          <Section title="Transcription notes">
            <dl className="space-y-2 text-xs">
              {Object.entries(spec.notes).map(([key, text]) => (
                <div key={key}>
                  <dt className="font-mono font-medium text-foreground">{key}</dt>
                  <dd className="text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        <Separator />

        <Section title="Evaluate">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="formula-target">Target</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="formula-target">
                  <SelectValue placeholder="Choose a target" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.id} · {t.kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {inputFields.map((f) => (
                <div key={f.symbol} className="space-y-1.5">
                  <Label htmlFor={`in-${f.symbol}`} className="font-mono text-xs">
                    {f.symbol}
                    {f.unit ? (
                      <span className="ml-1 font-sans text-muted-foreground">({f.unit})</span>
                    ) : null}
                  </Label>
                  <Input
                    id={`in-${f.symbol}`}
                    value={inputs[f.symbol] ?? ''}
                    placeholder={f.label === f.symbol ? '' : f.label}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [f.symbol]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            <Button onClick={run} disabled={running || !target}>
              {running ? <Spinner /> : null}
              Evaluate formula
            </Button>

            {result ? (
              <div
                className={cn(
                  'space-y-3 rounded-md border p-3',
                  result.ok ? 'border-border bg-muted/40' : 'border-destructive/40 bg-muted/40',
                )}
              >
                {result.ok ? (
                  <p className="font-mono text-lg text-foreground">{String(result.value)}</p>
                ) : (
                  <p className="text-xs text-destructive">{result.error}</p>
                )}
                {result.trace.length > 0 ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Derivation ({result.trace.length} steps)
                    </summary>
                    <ol className="mt-2 space-y-1 text-muted-foreground">
                      {result.trace.map((step, i) => (
                        <li key={i} className="font-mono">
                          {step.kind === 'symbol' ? (
                            <>
                              {step.symbol} = {String(step.value)}{' '}
                              <span className="opacity-60">({step.from})</span>
                            </>
                          ) : step.kind === 'expression' ? (
                            <>
                              {step.id} → {String(step.value)}
                            </>
                          ) : step.kind === 'branch' ? (
                            <>
                              {step.id}: {step.label ?? step.chose} — {step.when}
                            </>
                          ) : (
                            <>
                              {step.id}[
                              {Object.entries(step.key)
                                .map(([k, v]) => `${k}=${String(v)}`)
                                .join(', ')}
                              ] → {String(step.value)}
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>
      </div>
    </div>
  );
}
