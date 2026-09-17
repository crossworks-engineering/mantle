'use client';

import { useMemo, useState } from 'react';
import { parseInputText } from '@mantle/content-core/formula-eval';
import type { FormulaValue } from '@mantle/content-core/formula-spec';
import type { TargetSignature } from '@mantle/content-core/formula-signature';
import type { TraceStep } from '@mantle/content-core/formula-eval';

/**
 * The live calculator on a shared formula — a client island, because it is the
 * one part of the page that has to talk back to the server.
 *
 * Its fields come from the Phase 1 signature, embedded in the page payload
 * rather than re-derived here: which symbols a target needs, which are
 * optional, and what the legal values of a rating are. A visitor on a public
 * link has no way to read the resolution ladder, so anything this got wrong
 * would surface as a bare "missing required input" they could not act on.
 *
 * It renders the DERIVATION, not just the number. A shared engineering result
 * that cannot be checked is worth very little, and the trace is the difference
 * between showing your work and asserting an answer.
 */

type EvalResponse =
  | { ok: true; value: FormulaValue; trace: TraceStep[] }
  | { ok: false; error: string; trace?: TraceStep[] };

export function FormulaCalculator({
  token,
  signature,
}: {
  token: string;
  signature: TargetSignature[];
}) {
  const [target, setTarget] = useState(signature[0]?.id ?? '');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<EvalResponse | null>(null);
  const [running, setRunning] = useState(false);

  const active = useMemo(() => signature.find((s) => s.id === target), [signature, target]);
  const fields = active?.inputs ?? [];

  async function run() {
    if (!target) return;
    setRunning(true);
    try {
      const supplied: Record<string, FormulaValue> = {};
      for (const [k, v] of Object.entries(inputs)) {
        const parsed = parseInputText(v);
        if (parsed !== undefined) supplied[k] = parsed;
      }
      const res = await fetch(`/s/${encodeURIComponent(token)}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, inputs: supplied }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<EvalResponse> & {
        error?: string;
      };
      if (!res.ok) {
        setResult({ ok: false, error: body.error ?? `${res.status} ${res.statusText}` });
      } else {
        setResult(body as EvalResponse);
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : 'evaluation failed' });
    } finally {
      setRunning(false);
    }
  }

  if (signature.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-semibold text-foreground">Calculate</h2>

      <label className="mt-4 block text-xs font-medium text-muted-foreground" htmlFor="calc-target">
        What to compute
      </label>
      <select
        id="calc-target"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          setResult(null);
        }}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
      >
        {signature.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id}
            {s.produces ? ` → ${s.produces}${s.unit ? ` [${s.unit}]` : ''}` : ''}
          </option>
        ))}
      </select>

      {active && active.unverified.length > 0 ? (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-muted-foreground">
          This result depends on {active.unverified.length} equation
          {active.unverified.length === 1 ? '' : 's'} that{' '}
          {active.unverified.length === 1 ? 'was' : 'were'} not read from the source.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.symbol}>
            <label
              className="block text-xs font-medium text-muted-foreground"
              htmlFor={`calc-${f.symbol}`}
            >
              <span className="font-mono text-foreground">{f.symbol}</span>
              {f.unit ? ` (${f.unit})` : ''}
              {f.required ? '' : ' — optional'}
            </label>
            {f.name ? <p className="text-[11px] text-muted-foreground">{f.name}</p> : null}
            {f.kind === 'enum' && f.domain?.length ? (
              <select
                id={`calc-${f.symbol}`}
                value={inputs[f.symbol] ?? ''}
                onChange={(e) => setInputs((p) => ({ ...p, [f.symbol]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="">Choose…</option>
                {f.domain.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                    {f.criteria?.[String(v)] ? ` — ${f.criteria[String(v)]}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`calc-${f.symbol}`}
                value={inputs[f.symbol] ?? ''}
                placeholder={f.default !== undefined ? String(f.default) : ''}
                onChange={(e) => setInputs((p) => ({ ...p, [f.symbol]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            )}
          </div>
        ))}
      </div>

      <button
        onClick={run}
        disabled={running || !target}
        className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {running ? 'Calculating…' : 'Calculate'}
      </button>

      {result ? (
        <div
          className={`mt-4 rounded-md border p-4 ${
            result.ok ? 'border-border bg-muted/40' : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          {result.ok ? (
            <p className="font-mono text-2xl text-foreground">
              {String(result.value)}
              {active?.unit ? (
                <span className="ml-2 text-sm text-muted-foreground">{active.unit}</span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-destructive-ink">{result.error}</p>
          )}
          {result.trace && result.trace.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Derivation ({result.trace.length} steps)
              </summary>
              <ol className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                {result.trace.map((step, i) => (
                  <li key={i}>
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
  );
}
