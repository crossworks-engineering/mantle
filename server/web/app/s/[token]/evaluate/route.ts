import { NextResponse } from '@/server/http-compat';
import { evaluateSpec, parseFormulaSpec, type FormulaValue } from '@mantle/content';
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { resolveActiveShareByToken } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * Evaluate one target of a SHARED formula — the public counterpart of
 * /api/formulas/[id]/evaluate, and the reason a shared link is a calculator
 * rather than a screenshot.
 *
 * Why this is a safe public compute surface: `evaluateSpec` is pure. No model,
 * no network, no DB write, no filesystem — a hand-written recursive-descent
 * parser over a fixed grammar and function set, with no path to a global
 * scope. The worst a hostile body can do is spend a few microseconds of CPU.
 *
 * The caps below exist anyway, because "cheap" is not "free" and a public
 * endpoint gets what it gets: a rate limit per IP, a ceiling on how many
 * symbols may be supplied, and a ceiling on the size of each value (a
 * megabyte-long string would otherwise be concatenated and returned).
 *
 * Authorization matches the rows route exactly — an active formula share plus,
 * in team mode, a live team session. Everything else 404s uniformly so a URL
 * never reveals that a token exists.
 */

/** Enough for the largest real model; far below anything that costs time. */
const MAX_INPUT_KEYS = 200;
const MAX_VALUE_LENGTH = 1000;

function notFound() {
  return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const { ok: allowed, retryAfterSec } = rateLimit(`share-evaluate:${clientIp(req)}`, {
    max: 60,
    windowMs: 60_000,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: 'too many requests' },
      {
        status: 429,
        headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
      },
    );
  }

  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'formula') return notFound();
  if (!(await resolveShareVisitor(req.headers.get('cookie'), share))) return notFound();

  const raw = (await req.json().catch(() => null)) as {
    target?: unknown;
    inputs?: unknown;
  } | null;
  const target = typeof raw?.target === 'string' ? raw.target.trim() : '';
  if (!target) {
    return NextResponse.json({ error: 'target is required' }, { status: 400 });
  }

  const inputs: Record<string, FormulaValue> = {};
  if (raw?.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs)) {
    const entries = Object.entries(raw.inputs as Record<string, unknown>);
    if (entries.length > MAX_INPUT_KEYS) {
      return NextResponse.json({ error: 'too many inputs' }, { status: 400 });
    }
    for (const [k, v] of entries) {
      if (v === null) continue;
      if (typeof v === 'number' && Number.isFinite(v)) inputs[k] = v;
      else if (typeof v === 'boolean') inputs[k] = v;
      else if (typeof v === 'string' && v.length <= MAX_VALUE_LENGTH) inputs[k] = v;
      // Objects, arrays and oversized strings are dropped rather than rejected:
      // an unsupplied symbol produces the evaluator's own corrective error,
      // which is more use to the caller than a generic 400.
    }
  }

  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(
      and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'formula')),
    )
    .limit(1);
  if (!row) return notFound();

  const parsed = parseFormulaSpec((row.data as Record<string, unknown> | null)?.spec);
  if (!parsed.ok) return notFound();

  const result = evaluateSpec(parsed.spec, target, inputs);
  // The evaluator's messages are already corrective ("missing required input
  // 'Pgauge' (lbf/in2)"), so they pass through unchanged — a visitor who
  // cannot see the spec's internals needs them more than the owner does.
  return NextResponse.json(
    result.ok
      ? { ok: true, value: result.value, trace: result.trace }
      : { ok: false, error: result.error, trace: result.trace },
    { headers: { 'cache-control': 'no-store' } },
  );
}
