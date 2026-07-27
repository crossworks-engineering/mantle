import katex from 'katex';
import type { ReactNode } from 'react';
import type {
  CoverageGap,
  DimensionIssue,
  FormulaSpec,
  FormulaValue,
  SpecLookup,
} from '@mantle/content';

/**
 * Public render of a shared formula: the calculation model, its citation, and
 * every caveat that travels with it.
 *
 * The static half lives here (server-rendered to HTML, no hydration); the live
 * calculator mounts separately as a client island. That split is deliberate —
 * the equations, the tables and above all the WARNINGS must be readable with
 * JavaScript off or broken, because a shared engineering calculation that
 * silently renders without its `unverified` notice is worse than one that does
 * not render at all.
 *
 * KaTeX runs server-side with `trust: false` (its default, pinned because the
 * output goes through dangerouslySetInnerHTML): a spec transcribed by an agent
 * from a pasted document must not be able to inject a link or fetch a remote
 * asset onto a public page.
 */

function cell(v: FormulaValue | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

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

function Equation({ latex, expression }: { latex?: string; expression: string }) {
  if (latex) {
    let html: string | null;
    try {
      html = katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: false });
    } catch {
      // Unrenderable display string — fall through to the literal expression,
      // which is what is actually computed anyway.
      html = null;
    }
    if (html) {
      return (
        <div
          className="overflow-x-auto py-2"
          // KaTeX output from the spec's own display string, trust:false.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
  }
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      <code>{expression}</code>
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function LookupTable({ lookup }: { lookup: SpecLookup }) {
  const columns = [...lookup.keys, lookup.result];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c} className="px-2 py-1.5 text-left font-mono text-xs text-muted-foreground">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lookup.rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50">
              {columns.map((c) => (
                <td key={c} className="px-2 py-1.5 font-mono text-xs">
                  {cell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type FormulaShareView = {
  title: string;
  spec: FormulaSpec;
  coverageGaps: CoverageGap[];
  dimensionIssues: DimensionIssue[];
};

export function FormulaPresenter({
  view,
  calculator,
}: {
  view: FormulaShareView;
  /** The live calculator: the /s surface passes pre-rendered island markup
   *  (wrapped in its own dangerouslySetInnerHTML div); the /team inline
   *  reader mounts <FormulaCalculator> directly. */
  calculator: ReactNode;
}) {
  const { spec } = view;
  const cite = citation(spec);
  const unverified = spec.expressions.filter((e) => e.unverified);

  return (
    <article className="mx-auto max-w-3xl px-6 py-12 md:py-16">
      <h1 className="text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      {cite ? <p className="mt-2 text-sm text-muted-foreground">{cite}</p> : null}
      {spec.unitSystem ? (
        <p className="mt-1 text-xs text-muted-foreground">Unit system: {spec.unitSystem}</p>
      ) : null}

      {/* Caveats first. Someone who reads nothing else must still see these. */}
      {unverified.length > 0 ? (
        <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-foreground">
            {unverified.length} equation{unverified.length === 1 ? '' : 's'} here{' '}
            {unverified.length === 1 ? 'was' : 'were'} not read from the source
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {unverified.map((e) => (
              <li key={e.id}>
                <code>{e.id}</code> — {e.unverified}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.dimensionIssues.length > 0 ? (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-foreground">
            The arithmetic disagrees with a declared unit
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {view.dimensionIssues.map((d, i) => (
              <li key={i}>
                <code>{d.id}</code> — {d.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.coverageGaps.length > 0 ? (
        <div className="mt-4 rounded-md border border-border bg-muted/50 p-4">
          <p className="text-sm font-medium text-foreground">
            The source leaves {view.coverageGaps.length} key combination
            {view.coverageGaps.length === 1 ? '' : 's'} unspecified
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Evaluating one of these is an error rather than a zero.
          </p>
        </div>
      ) : null}

      {/* The calculator: the reason a link exists rather than a screenshot. */}
      <div className="mt-10">{calculator}</div>

      {spec.expressions.length > 0 ? (
        <Section title="Equations">
          <div className="space-y-5">
            {spec.expressions.map((e) => (
              <div key={e.id} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
                  <code className="font-medium text-foreground">{e.id}</code>
                  {e.equation ? <span>Eq {e.equation}</span> : null}
                  {e.resultSymbol ? (
                    <span>
                      → {e.resultSymbol}
                      {e.unit ? ` [${e.unit}]` : ''}
                    </span>
                  ) : null}
                </div>
                <Equation latex={e.latex} expression={e.expression} />
                {e.unverified ? (
                  <p className="text-xs text-destructive-ink">Unverified — {e.unverified}</p>
                ) : null}
                {e.note ? <p className="text-xs text-muted-foreground">{e.note}</p> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {spec.piecewise.length > 0 ? (
        <Section title="Conditional selection">
          {spec.piecewise.map((p) => (
            <div key={p.id} className="space-y-1 text-sm">
              <code className="text-xs font-medium text-foreground">{p.id}</code>
              <ul className="space-y-1 text-xs text-muted-foreground">
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Symbol', 'Description', 'Value', 'Unit', 'Role'].map((h) => (
                    <th key={h} className="px-2 py-1.5 text-left text-xs text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.variables.map((v) => (
                  <tr key={v.symbol} className="border-b border-border/50">
                    <td className="px-2 py-1.5 font-mono text-xs">{v.symbol}</td>
                    <td className="px-2 py-1.5 text-xs">{v.name ?? ''}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">
                      {v.expression ?? (v.value !== undefined ? String(v.value) : '')}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{v.unit ?? ''}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{v.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {spec.lookups.map((lookup) => (
        <Section key={lookup.id} title={lookup.name ?? lookup.id}>
          <LookupTable lookup={lookup} />
        </Section>
      ))}

      {spec.classifications.map((c) => (
        <Section key={c.id} title={c.id}>
          <dl className="space-y-2 text-sm">
            {c.domain.map((value) => (
              <div key={value} className="flex gap-3">
                <dt className="w-8 shrink-0 font-mono text-xs font-medium text-foreground">
                  {value}
                </dt>
                <dd className="text-xs text-muted-foreground">{c.criteria[value]}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}

      {spec.notes && Object.keys(spec.notes).length > 0 ? (
        <Section title="Transcription notes">
          <dl className="space-y-2">
            {Object.entries(spec.notes).map(([key, text]) => (
              <div key={key}>
                <dt className="font-mono text-xs font-medium text-foreground">{key}</dt>
                <dd className="text-xs text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
    </article>
  );
}
