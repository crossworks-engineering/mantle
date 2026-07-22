/**
 * Render a FormulaSpec to plaintext markdown so the brain can index a formula
 * the same way it indexes everything else. The Formulas analog of `docToText`
 * for Pages and `tableToText` for Tables: the extractor + FTS read this string,
 * never the structured JSON.
 *
 * What gets rendered is chosen for RETRIEVAL, not for display. The questions a
 * formula has to answer are "which calculation covers a leaking vessel?",
 * "where does the 0.61 discharge coefficient come from?" and "what counts as a
 * grade B detection system?" — so the source citation, the variable table with
 * its units, and above all the classification criteria PROSE are included. That
 * prose is the most searchable thing in a spec and the easiest to forget, since
 * it is the one part that never takes part in a calculation.
 *
 * Lossy by design; pure, no DB.
 */
import type { FormulaSpec, FormulaValue, SpecLookup } from './formula-spec';

function cell(v: FormulaValue | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function citation(spec: FormulaSpec): string {
  const s = spec.source;
  if (!s) return '';
  const bits = [s.standard, s.part ? `Part ${s.part}` : '', s.edition ? `(${s.edition})` : '']
    .filter(Boolean)
    .join(' ');
  const sections = s.sections?.length ? `, §${s.sections.join(', §')}` : '';
  const tables = s.tables?.length ? `, Tables ${s.tables.join(', ')}` : '';
  return `${bits}${sections}${tables}`.trim();
}

function lookupTable(lookup: SpecLookup): string[] {
  const columns = [...lookup.keys, lookup.result];
  const lines = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...lookup.rows.map((row) => `| ${columns.map((c) => cell(row[c])).join(' | ')} |`),
  ];
  return lines;
}

export function formulaToText(spec: FormulaSpec): string {
  const out: string[] = [];

  out.push(`# ${spec.name ?? spec.id}`);
  const cite = citation(spec);
  if (cite) out.push(`Source: ${cite}`);
  if (spec.unitSystem) out.push(`Unit system: ${spec.unitSystem}`);

  if (spec.expressions.length > 0) {
    out.push('', '## Equations');
    for (const e of spec.expressions) {
      const label = e.equation ? `${e.id} (Eq ${e.equation})` : e.id;
      const produces = e.resultSymbol ? ` → ${e.resultSymbol}${e.unit ? ` [${e.unit}]` : ''}` : '';
      out.push(`- ${label}${produces}: ${e.expression}`);
      if (e.note) out.push(`  ${e.note}`);
    }
  }

  if (spec.piecewise.length > 0) {
    out.push('', '## Conditional selection');
    for (const p of spec.piecewise) {
      out.push(`- ${p.id}:`);
      for (const c of p.cases) {
        out.push(`  - ${c.label ? `${c.label} — ` : ''}when ${c.when} use ${c.use}`);
      }
      if (p.otherwise) out.push(`  - otherwise use ${p.otherwise}`);
    }
  }

  if (spec.variables.length > 0) {
    out.push('', '## Variables');
    out.push('| Symbol | Description | Value | Unit | Role |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const v of spec.variables) {
      const value = v.expression ? v.expression : (v.value ?? '');
      out.push(
        `| ${cell(v.symbol)} | ${cell(v.name ?? '')} | ${cell(value as FormulaValue)} | ${cell(v.unit ?? '')} | ${v.role} |`,
      );
    }
  }

  for (const lookup of spec.lookups) {
    out.push('', `## ${lookup.name ?? lookup.id}`);
    out.push(...lookupTable(lookup));
  }

  for (const c of spec.classifications) {
    out.push('', `## ${c.id}`);
    for (const value of c.domain) {
      const criterion = c.criteria[value];
      if (criterion) out.push(`- ${value}: ${criterion}`);
    }
  }

  if (spec.notes) {
    const entries = Object.entries(spec.notes);
    if (entries.length > 0) {
      out.push('', '## Notes');
      for (const [key, text] of entries) out.push(`- ${key}: ${text}`);
    }
  }

  return out.join('\n').trim();
}
