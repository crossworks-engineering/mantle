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
 * entries (no model call). Idempotent. Persona notes are left as they are.
 *
 * Usage:
 *   pnpm maintain run persona-notes-to-journal -- --agent=<slug>
 *   pnpm maintain run persona-notes-to-journal -- --apply --page=<page-id>
 */
import { and, eq } from 'drizzle-orm';
import { activeNotes, agents, db, nodes, noteRef } from '@mantle/db';
import {
  PLAN_DATA_KEY,
  applyConversionPlan,
  buildConversionPlan,
  createPage,
  markdownToDoc,
  renderConversionPlanMarkdown,
  type ConversionPlan,
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

function parseJson(text: string): Record<string, unknown> {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  // A bare N12 key or value (unquoted) is not JSON; quote it.
  return JSON.parse(text.slice(a, b + 1).replace(/(?<!")\b([NP]\d+)\b(?!")/g, '"$1"')) as Record<
    string,
    unknown
  >;
}

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
        return parseJson(result.text);
      } catch (err) {
        if (attempt >= ATTEMPTS) throw err;
        console.log(` (retry: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
  };

  console.log(
    `${notes.length} live notes; sorting with ${routes.primary.provider}:${routes.primary.model}`,
  );
  const classes = new Map<string, NoteClass>();
  for (let i = 0; i < notes.length; i += CLASSIFY_BATCH) {
    const batch = notes.slice(i, i + CLASSIFY_BATCH);
    const list = batch.map((n, k) => `[N${k + 1}] (${n.kind}) ${n.content}`).join('\n');
    const json = await ask(
      CLASSIFY_SYSTEM,
      `${CLASSIFY_RULES}\n\nNOTES:\n${list}\n\nReturn JSON only: {"N<number>": {"kind": "...", "scope": "general|topic", "topic": "..."}, ...} for every note.`,
    );
    batch.forEach((n, k) => {
      const v = json[`N${k + 1}`] as NoteClass | undefined;
      if (v && typeof v === 'object') classes.set(n.ref, v);
    });
    process.stdout.write('.');
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
    const json = await ask(
      'You compare pairs of notes an assistant keeps about its user. Reply with JSON only.',
      `For each pair: "same" if one note could replace the other with no loss (same rule, maybe different words); "overlap" if they share a rule but each adds something; "different" otherwise.\n\n${list}\n\nReturn JSON only: {"P1": "same|overlap|different", ...}`,
    );
    batch.forEach(([a, b], k) => {
      if (json[`P${k + 1}`] === 'same') samePairs.push([notes[a]!.ref, notes[b]!.ref]);
    });
  }
  console.log(`${pairs.length} near-copy pairs, ${samePairs.length} confirmed the same`);

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
        'pnpm maintain run persona-notes-to-journal -- --apply --page=<this page id>',
      ),
    ),
    data: { [PLAN_DATA_KEY]: plan },
  });
  console.log(`review page: ${page.id}  (model spend ~$${spent.toFixed(3)})`);
  console.log(`apply with:  --apply --page=${page.id}`);
}

async function apply(ownerId: string, pageId: string) {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, pageId), eq(nodes.type, 'page')))
    .limit(1);
  const plan = (row?.data as Record<string, unknown> | undefined)?.[PLAN_DATA_KEY] as
    ConversionPlan | undefined;
  if (!plan || plan.version !== 1) throw new Error(`page ${pageId} carries no conversion plan`);
  const r = await applyConversionPlan(ownerId, plan);
  console.log(
    `agent '${plan.agentSlug}': created ${r.created} Journal entries, ${r.existing} already there, ${r.duplicates} duplicates skipped`,
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

main().then(
  () => process.exit(0),
  (err) => {
    console.error('persona-notes-to-journal:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
