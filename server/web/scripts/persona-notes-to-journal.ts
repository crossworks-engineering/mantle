/**
 * Persona notes → Journal, one agent at a time (spike 13, dev-brain page
 * 9f57fa46; the plan/apply logic lives in @mantle/content
 * persona-notes-journal.ts).
 *
 * Dry run (default): the agent's OWN chat model sorts every live persona note
 * into a Journal kind (general → always on; topic → picked per turn), the
 * brain's embedder finds near-copies (cosine ≥ 0.85) and the same model
 * confirms each pair, and the plan is written to a review page. Prints the
 * page id. Spends model tokens (~$0.30 for 500 notes on a Sonnet-class model).
 *
 * Apply: `--apply --page=<id>` turns THAT page's stored plan into Journal
 * entries (no sorting call; each entry is indexed, which runs the extractor).
 * Idempotent. Notes retired since the dry run are skipped; notes learned
 * since are reported (re-run the dry run for them). Persona notes are left as
 * they are.
 *
 * Usage (both spend, so both need --yes):
 *   pnpm maintain persona-notes-to-journal --agent=<slug> --yes
 *   pnpm maintain persona-notes-to-journal --apply --page=<page-id> --yes
 * Inside a box's container the owner id is not in the environment:
 *   docker exec -w /app -e ALLOWED_USER_ID=<owner id> mantle_web \
 *     pnpm maintain persona-notes-to-journal --agent=<slug> --yes
 */
import { and, eq } from 'drizzle-orm';
import { activeNotes, agents, closeDb, db, nodes, noteRef } from '@mantle/db';
import {
  PLAN_DATA_KEY,
  applyConversionPlan,
  buildConversionPlan,
  createPage,
  markdownToDoc,
  parseConversionPlan,
  parseLooseJson,
  parseNoteClass,
  planStaleness,
  renderConversionPlanMarkdown,
  type NoteClass,
} from '@mantle/content';
import { embedBatch } from '@mantle/embeddings';
import { chatWithFailover, resolveChatRoutes } from '@mantle/runtime/agent';
import { env } from '@mantle/config';

const OWNER_ID = env('ALLOWED_USER_ID');
// Small batches: a one-shot chat call is capped at 60 s, and a reasoning model
// sorting 40 notes ran close to it (the first real dry run timed out).
const CLASSIFY_BATCH = 15;
const JUDGE_BATCH = 15;
const ATTEMPTS = 2;
const NEAR_COPY = 0.85;

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const CLASSIFY_SYSTEM = `You sort notes an assistant wrote about how to help its user. Each note becomes one Journal entry kind. Reply with JSON only.`;
const CLASSIFY_RULES = `Kinds:
- "preference": how the user wants the assistant to work IN GENERAL, relevant to most requests (tone, length, format, where outputs go, how to ask, habits across all tasks).
- "identity": who the user or organisation is (role, team, site, responsibilities).
- "context": background facts about the user's situation that are not rules.
- "expectation": a standard or rule for ONE kind of task, document, app, dataset or calculation. Only matters when the conversation is on that topic.
- "lesson": like expectation, but learned from a specific past outcome or mistake.
Also give "scope": "general" (applies to most conversations) or "topic" (only when the topic comes up), and "topic": a 2-5 word label.`;

const cosine = (a: number[], b: number[]) => {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    x += a[i]! ** 2;
    y += b[i]! ** 2;
  }
  return d / Math.sqrt(x * y);
};

async function dryRun(ownerId: string, slug: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug)))
    .limit(1);
  if (!agent) throw new Error(`no agent '${slug}' for this owner`);
  const notes = activeNotes(agent.personaNotes ?? [])
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((n) => ({ ref: noteRef(n), kind: n.kind, content: n.content }));
  if (notes.length === 0) {
    console.log(`agent '${slug}' has no live persona notes; nothing to plan`);
    return;
  }
  const routes = resolveChatRoutes(agent);
  let spent = 0;
  // One retry per batch: a single slow or garbled answer used to end a run
  // of hundreds of notes and throw away what it had already paid for.
  const ask = async (system: string, user: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const { result } = await chatWithFailover(ownerId, routes, {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          maxTokens: 12_000,
          // Sorting needs no deep thought; a reasoning model at its default
          // effort (grok) ran past the 60 s one-shot cap on 15 notes.
          thinkingEffort: 'low',
        });
        spent += result.reportedCostUsd ?? 0;
        return parseLooseJson(result.text);
      } catch (err) {
        if (attempt >= ATTEMPTS) throw err;
        console.log(` (retry: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
  };

  console.log(
    `${notes.length} live notes; sorting with ${routes.primary.provider}:${routes.primary.model}`,
  );
  // A batch that still fails after its retry leaves its notes unsorted (the
  // plan places them per turn and the page lists them); the run goes on, so
  // what was already paid for is kept.
  const classes = new Map<string, NoteClass>();
  let failedBatches = 0;
  for (let i = 0; i < notes.length; i += CLASSIFY_BATCH) {
    const batch = notes.slice(i, i + CLASSIFY_BATCH);
    const list = batch.map((n, k) => `[N${k + 1}] (${n.kind}) ${n.content}`).join('\n');
    try {
      const json = await ask(
        CLASSIFY_SYSTEM,
        `${CLASSIFY_RULES}\n\nNOTES:\n${list}\n\nReturn JSON only: {"N<number>": {"kind": "...", "scope": "general|topic", "topic": "..."}, ...} for every note.`,
      );
      batch.forEach((n, k) => {
        const v = parseNoteClass(json[`N${k + 1}`]);
        if (v) classes.set(n.ref, v);
      });
      process.stdout.write('.');
    } catch (err) {
      failedBatches++;
      console.log(` (batch failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  console.log(` sorted ${classes.size}/${notes.length}`);

  const vecs = await embedBatch(
    ownerId,
    notes.map((n) => n.content),
  );
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++)
      if (cosine(vecs[i]!, vecs[j]!) >= NEAR_COPY) pairs.push([i, j]);
  const samePairs: Array<[string, string]> = [];
  for (let i = 0; i < pairs.length; i += JUDGE_BATCH) {
    const batch = pairs.slice(i, i + JUDGE_BATCH);
    const list = batch
      .map(([a, b], k) => `[P${k + 1}]\nA: ${notes[a]!.content}\nB: ${notes[b]!.content}`)
      .join('\n\n');
    try {
      const json = await ask(
        'You compare pairs of notes an assistant keeps about its user. Reply with JSON only.',
        `For each pair: "same" if one note could replace the other with no loss (same rule, maybe different words); "overlap" if they share a rule but each adds something; "different" otherwise.\n\n${list}\n\nReturn JSON only: {"P1": "same|overlap|different", ...}`,
      );
      batch.forEach(([a, b], k) => {
        const v = json[`P${k + 1}`];
        if (typeof v === 'string' && v.trim().toLowerCase() === 'same') {
          samePairs.push([notes[a]!.ref, notes[b]!.ref]);
        }
      });
    } catch (err) {
      // An unjudged pair stays two entries: a missed merge, never a lost note.
      failedBatches++;
      console.log(` (pair batch failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  console.log(`${pairs.length} near-copy pairs, ${samePairs.length} confirmed the same`);
  if (failedBatches > 0) console.log(`${failedBatches} batch(es) failed after a retry`);

  const plan = buildConversionPlan({
    agentId: agent.id,
    agentSlug: agent.slug,
    model: `${routes.primary.provider}:${routes.primary.model}`,
    notes,
    classes,
    samePairs,
  });
  const page = await createPage(ownerId, {
    title: `Persona notes → Journal (dry run): ${agent.name}`,
    icon: '🧭',
    tags: ['persona-notes', 'journal', 'dry-run'],
    doc: markdownToDoc(
      renderConversionPlanMarkdown(
        plan,
        'pnpm maintain persona-notes-to-journal --apply --page=<this page id> --yes',
      ),
    ),
    data: { [PLAN_DATA_KEY]: plan },
  });
  console.log(
    `review page: ${page.id}  (sorting spend ~$${spent.toFixed(3)}, embeddings not counted)`,
  );
  console.log(
    `apply with:  pnpm maintain persona-notes-to-journal --apply --page=${page.id} --yes`,
  );
}

async function apply(ownerId: string, pageId: string) {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, pageId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) throw new Error(`no page ${pageId} for this owner`);
  const plan = parseConversionPlan((row.data as Record<string, unknown> | null)?.[PLAN_DATA_KEY]);
  const [agent] = await db
    .select({ id: agents.id, slug: agents.slug, personaNotes: agents.personaNotes })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, plan.agentId)))
    .limit(1);
  if (!agent || agent.slug !== plan.agentSlug) {
    throw new Error(`the plan's agent '${plan.agentSlug}' is not an agent of this owner`);
  }
  const live = new Set(activeNotes(agent.personaNotes ?? []).map(noteRef));
  const stale = planStaleness(plan, live);
  if (stale.retired.length > 0) {
    console.log(`${stale.retired.length} note(s) retired since the dry run: not brought back`);
  }
  if (stale.added.length > 0) {
    console.log(
      `${stale.added.length} note(s) learned since the dry run are NOT in this plan: re-run the dry run to include them`,
    );
  }
  const r = await applyConversionPlan(ownerId, plan, { skipRefs: new Set(stale.retired) });
  console.log(
    `agent '${plan.agentSlug}': created ${r.created} Journal entries, ${r.existing} already there, ${r.duplicates} duplicates and ${r.skipped} retired skipped`,
  );
}

async function main() {
  if (!OWNER_ID) throw new Error('ALLOWED_USER_ID must be set');
  if (process.argv.includes('--apply')) {
    const page = arg('page');
    if (!page) throw new Error('--apply needs --page=<review page id>');
    await apply(OWNER_ID, page);
  } else {
    const slug = arg('agent');
    if (!slug) throw new Error('--agent=<slug> is required');
    await dryRun(OWNER_ID, slug);
  }
}

// One-shot script: close the pooled client so the process can exit, and
// set the exit code rather than calling process.exit (flushes output).
main()
  .catch((err) => {
    console.error('persona-notes-to-journal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
