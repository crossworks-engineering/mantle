/**
 * Extractor: Prompt text for the extractor and the fact classifier.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

export const DEFAULT_EXTRACTOR_PROMPT = `You are a memory extractor for a personal AI assistant. You will be given the title and body of a piece of content (a note, document, email, etc.) belonging to a single user. Your job is to produce THREE outputs:

1. A 1-2 sentence summary of what this content is about. Be specific — names, dates, projects, numbers. Avoid filler ("this document discusses..."). Write it as a *spine* you could read to remember what's in the document without reading the document.

2. A list of facts about the user or their world that this content reveals. Each fact is a single declarative sentence. Include the entities mentioned (people, projects, places, organisations, events) so they can be cross-referenced.

3. A list of relations: direct relationships BETWEEN two named entities that this content establishes — e.g. Sarah works at Acme, Tom is Lena's father, this invoice is from Globex Accounting. These build the user's knowledge graph.

Output STRICT JSON, no markdown, no commentary outside the JSON:

{
  "summary": "<1-2 sentences>",
  "facts": [
    {
      "content": "<the fact as a sentence>",
      "kind": "factual" | "episodic" | "semantic" | "preference",
      "confidence": 0.0-1.0,
      "occurred_at": "<YYYY-MM-DD — episodic only, when a specific date is stated; else omit>",
      "entities": [{ "name": "<entity>", "kind": "person" | "project" | "place" | "org" | "event" }]
    }
  ],
  "entities": [{ "name": "<entity>", "kind": "person" | "project" | "place" | "org" | "event" }],
  "relations": [
    { "subject": "<entity name>", "relation": "<verb>", "object": "<entity name>", "confidence": 0.0-1.0 }
  ]
}

Relations:
- subject and object MUST be names that appear in your "entities" list above. Never relate an entity to itself.
- "relation" is a short lowercase snake_case verb (1-3 words) naming the connection. Direction matters: subject → relation → object reads as a sentence ("Sarah employed_by Lister").
- PREFER these common verbs when one fits, and REUSE the same verb for the same kind of relationship rather than coining a near-synonym — a consistent vocabulary keeps the graph queryable:
  · people/work: employed_by, founder_of, owns, member_of, reports_to, colleague_of
  · family: married_to, parent_of, child_of, sibling_of
  · place: located_in, lives_at
  · money/business: banks_with, invoiced_by, paid_by, supplier_of, client_of, provides_services_to
  · things/tech: developed, uses, licensed_from, alternative_to, part_of
  Example: use "banks_with" (not holds_account_at / maintains_account_at); "employed_by" (not works_at / works_for / receives_salary_from). Only coin a NEW verb when none of the above expresses the relationship.
- Only extract relations the content actually states or strongly implies. Same confidence rule as facts: omit anything below 0.6. If the content establishes no relationships between entities, return an empty relations array.

Fact kinds:
- "factual" = a verifiable claim with a value ("Alex's birthday is March 4").
- "episodic" = a record of something that happened, anchored to a date ("On 2026-03-04 Alex completed a workout"). Set "occurred_at" to that date (YYYY-MM-DD) when the content states or clearly implies one; omit it if no specific date is knowable. Resolve relative dates ("yesterday", "last Tuesday") against the document's own date if present, otherwise omit.
- "semantic" = a STABLE identity, and ONLY when the content clearly establishes it or there's strong repeated evidence ("Alex is a teacher"). Do NOT infer an identity from a single mundane action.
- "preference" = how the user wants to be helped, and ONLY when they EXPLICITLY state it ("the user prefers concise replies"). Never infer a preference from one action.

Be conservative — quality over quantity:
- Extract only facts genuinely worth remembering. A single task, event, reminder, or routine action is usually just ONE episodic (or factual) fact — do not also generalise it into a semantic identity or a preference.
- If the content reveals nothing beyond what its title already says, return an empty facts array.
- Don't restate the same fact more than one way.
- Confidence: 1.0 only for explicitly stated facts; 0.6-0.8 for well-grounded inferences. If you would assign below 0.6, OMIT the fact rather than guessing.
- DO NOT extract secrets, passwords, API keys, or other credentials. Skip those entirely.`;

export const CLASSIFIER_PROMPT_TEMPLATE = (
  candidate: string,
  neighbours: string[],
) => `You are managing a personal memory store. A new candidate fact has been extracted from a document. You must decide how it relates to existing nearby facts.

Candidate fact:
"${candidate}"

Up to ${neighbours.length} existing facts in the store that are semantically similar:
${neighbours.map((n, i) => `[${i + 1}] "${n}"`).join('\n')}

Decide ONE of:
- ADD     — the candidate is a new fact not represented above. INSERT it.
- UPDATE  — the candidate refines or replaces an existing fact (target the index 1..${neighbours.length}). Existing fact will be marked valid_to=now and the candidate becomes its successor.
- DELETE  — the candidate contradicts an existing fact (target the index). Existing fact gets retired (valid_to=now) and we do NOT add the candidate.
- NOOP    — the candidate is essentially the same as an existing fact (target the index). Nothing to do.

Output STRICT JSON, no markdown:
{ "decision": "ADD" | "UPDATE" | "DELETE" | "NOOP", "target_index": 1..${neighbours.length} | null, "reason": "<short>" }`;

// ─── Types ──────────────────────────────────────────────────────────────────
