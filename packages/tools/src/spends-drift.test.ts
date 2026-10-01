/**
 * Drift guard for the `spends` flag (audit F17). A builtin that starts paid
 * model work on a call (a chat, vision, speech, image or decider adapter, a
 * web-search model, a delegated agent) must say so with `spends: true`: a
 * member's app refuses every such tool (member-app-tools.ts), and
 * `readOnly` alone was not enough (extract_from_image is read-only and ran
 * the vision model on every call).
 *
 * The scan reads this package's sources: it splits each file into top-level
 * declarations, marks a declaration that calls one of the adapters below, or
 * a declaration already marked (in any file), as spending, until nothing
 * changes; every builtin tool object so marked must carry the flag. A new
 * adapter kind belongs in SPEND_CALLS.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from './builtins';

/** Calls that start paid model work. */
const SPEND_CALLS = [
  /\bget(Chat|Vision|ImageGen|Tts|Stt)Adapter\(/,
  /\bscorePassages\(/,
  /\bjudgeRulePairs\(/,
  /\bnew OpenRouter\(/,
  // A delegated agent turn (invoke_agent's child runs its own model).
  /\bgetAgentInvoker\(/,
];

type Segment = { file: string; name: string | null; slug: string | null; text: string };

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Top-level declarations: a new one starts at every column-0 line that is
 *  not a closer, a comment or blank. */
function segments(file: string): Segment[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Segment[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.join('\n');
    const head = cur[0]!;
    const name =
      /^(?:export )?(?:async )?function\*? (\w+)/.exec(head)?.[1] ??
      /^(?:export )?(?:const|let) (\w+)/.exec(head)?.[1] ??
      null;
    const isTool = /^(?:export )?const \w+: BuiltinToolDef = \{/.test(head);
    const slug = isTool ? (/^ {2}slug: '([a-z0-9_]+)'/m.exec(text)?.[1] ?? null) : null;
    out.push({ file, name, slug, text });
    cur = [];
  };
  for (const line of lines) {
    const starts = /^[A-Za-z_$]/.test(line) && !/^(import|from)\b/.test(line);
    if (starts) flush();
    cur.push(line);
  }
  flush();
  return out;
}

function spendingToolSlugs(): Set<string> {
  const all = sources(__dirname).flatMap(segments);
  const spending = new Set<Segment>();
  let changed = true;
  while (changed) {
    changed = false;
    const names = [...spending].map((s) => s.name).filter((n): n is string => !!n);
    const calls = names.map((n) => new RegExp(`\\b${n}\\(`));
    for (const seg of all) {
      if (spending.has(seg)) continue;
      const body = seg.name ? seg.text.replace(new RegExp(`\\b${seg.name}\\(`), '') : seg.text;
      if (SPEND_CALLS.some((re) => re.test(seg.text)) || calls.some((re) => re.test(body))) {
        spending.add(seg);
        changed = true;
      }
    }
  }
  return new Set([...spending].map((s) => s.slug).filter((s): s is string => !!s));
}

describe('the spends flag', () => {
  const detected = spendingToolSlugs();

  it('finds the known spenders (the scan is not vacuous)', () => {
    for (const slug of [
      'extract_from_image',
      'summarize_text',
      'search_chunks',
      'generate_image',
      'synthesize_speech',
      'video_ingest',
      'web_search',
      'invoke_agent',
    ]) {
      expect(detected, slug).toContain(slug);
    }
  });

  it('every builtin that calls a paid model adapter carries spends: true', () => {
    const bySlug = new Map(BUILTIN_TOOLS.map((t) => [t.slug, t]));
    const missing = [...detected].filter((slug) => bySlug.get(slug)?.spends !== true).sort();
    expect(missing, 'add `spends: true` to these builtins').toEqual([]);
  });

  it('nothing carries the flag without spending (it would refuse a free tool)', () => {
    const flagged = BUILTIN_TOOLS.filter((t) => t.spends === true).map((t) => t.slug);
    expect(flagged.filter((slug) => !detected.has(slug)).sort()).toEqual([]);
  });
});
