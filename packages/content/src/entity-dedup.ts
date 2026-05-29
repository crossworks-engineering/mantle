/**
 * Near-duplicate entity consolidation. Migration 0055 killed EXACT dups
 * (same name+kind) and the unique index prevents their recurrence. This is the
 * next frontier: NEAR-dups — the same real thing split across spelling/identifier
 * variants ("Jason" / "Jason Schoeman" / "jason@…"; "Pivotal Accounting" /
 * "Pivotal Accounting Solutions"). Left alone they fragment the graph (a path
 * from one variant silently misses edges on the others).
 *
 * Design: CONSERVATIVE + tiered. Detection never merges on its own — it scores
 * candidate pairs into:
 *   - 'auto'   — high-confidence, evidence-backed (org legal-suffix collapse;
 *                an email/phone-named entity resolved to a person via a
 *                matching contact). Safe to apply unattended.
 *   - 'review' — plausible but judgement-needed (person name token-subset;
 *                org descriptive-suffix; close trigram). Shown to the operator
 *                to confirm — never auto-applied.
 *
 * mergeEntities is the safe primitive (re-point edges + facts, fold the dup's
 * name/aliases into the canonical so future mentions resolve there, delete the
 * dup) — the same machinery 0055 used, as a callable function. Pure rule
 * helpers are exported for unit testing without a DB.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import {
  db,
  entities,
  entityEdges,
  entityMergeDismissals,
  facts,
  nodes,
  type Entity,
} from '@mantle/db';

/** Order two ids so a pair is direction-agnostic (matches the dismissal store). */
function orderedPair(a: string, b: string): [low: string, high: string] {
  return a < b ? [a, b] : [b, a];
}

// ─── Pure rule helpers (no DB — unit-tested) ─────────────────────────────────

/** Legal-entity suffixes safe to strip for org-name matching. Deliberately
 *  ONLY true legal forms — NOT descriptive words like "Solutions"/"Group"
 *  which can distinguish genuinely different orgs (those go to the review
 *  tier, not auto). */
const ORG_LEGAL_SUFFIXES = [
  'pty ltd', '(pty) ltd', 'pty limited', 'proprietary limited',
  'ltd', 'limited', 'inc', 'inc.', 'incorporated', 'llc', 'l.l.c.',
  'cc', 'gmbh', 'co', 'co.', 'corp', 'corp.', 'corporation', 'sa', 's.a.',
  'ltda', 'bv', 'b.v.', 'ag', 'plc',
];

/** Normalise an org name for matching: lowercase, strip punctuation, drop a
 *  trailing legal suffix. "Anysphere, Inc." → "anysphere"; "Pivotal
 *  Accounting (Pty) Ltd" → "pivotal accounting". */
export function normaliseOrgName(name: string): string {
  let s = name.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  // strip a trailing legal suffix (longest first so "pty ltd" beats "ltd")
  for (const suf of [...ORG_LEGAL_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (s.endsWith(' ' + suf)) {
      s = s.slice(0, -(suf.length + 1)).trim();
      break;
    }
  }
  return s;
}

export function isEmailName(name: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name.trim());
}

/** Bare phone-ish name: 7+ chars of digits/space/+()- and ≥7 digits. */
export function isPhoneName(name: string): boolean {
  const t = name.trim();
  if (!/^[0-9 +()\-]{7,}$/.test(t)) return false;
  return (t.replace(/\D/g, '').length) >= 7;
}

/** Tokens of a name, lowercased, alphanumerics only, length ≥ 2. */
function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2);
}

/** True if `shorter` is a strict, fewer-token subset of `longer` AND shares
 *  `longer`'s FIRST (given-name) token. The first-token requirement is the
 *  safety rule: it accepts "Jason" ⊂ "Jason Schoeman" but REJECTS the dangerous
 *  surname-only collision "C. Schoeman" → "Jason Schoeman" (different given
 *  name, same surname) and "Ann" → "Ashley Ann Schoeman" (middle name). Used
 *  for the person REVIEW tier — surname-only matches are too ambiguous to even
 *  suggest. */
export function isNameSubset(shorter: string, longer: string): boolean {
  const a = nameTokens(shorter);
  const bTokens = nameTokens(longer);
  const b = new Set(bTokens);
  if (a.length === 0 || a.length >= bTokens.length) return false;
  if (!a.every((t) => b.has(t))) return false;
  // must include the given (first) name — never match on surname alone
  return a.includes(bTokens[0]!);
}

// ─── Candidate detection ─────────────────────────────────────────────────────

export type MergeTier = 'auto' | 'review';
export type MergeCandidate = {
  canonicalId: string;
  canonicalName: string;
  dupId: string;
  dupName: string;
  kind: string;
  tier: MergeTier;
  reason: string;
};

type EntRow = Entity & { edgeCount: number };

/** Pick the canonical of two: more edges wins, then longer name, then earliest. */
function pickCanonical(a: EntRow, b: EntRow): [canonical: EntRow, dup: EntRow] {
  if (a.edgeCount !== b.edgeCount) return a.edgeCount > b.edgeCount ? [a, b] : [b, a];
  if (a.name.length !== b.name.length) return a.name.length > b.name.length ? [a, b] : [b, a];
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

/**
 * Detect near-duplicate entity pairs for an owner, tiered into auto / review.
 * Pure-ish: does its own reads but no writes. Returns one candidate per dup
 * (a dup merges into exactly one canonical).
 */
export async function findDuplicateCandidates(ownerId: string): Promise<MergeCandidate[]> {
  // Entities + their relation-edge counts (edges stamped with source_node_id).
  const ents = (await db
    .select({
      id: entities.id,
      ownerId: entities.ownerId,
      kind: entities.kind,
      name: entities.name,
      aliases: entities.aliases,
      data: entities.data,
      embedding: entities.embedding,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
      edgeCount: sql<number>`(
        select count(*)::int from ${entityEdges} ed
        where (ed.source_id = ${entities.id} or ed.target_id = ${entities.id})
          and ed.data ? 'source_node_id')`,
    })
    .from(entities)
    .where(eq(entities.ownerId, ownerId))) as EntRow[];

  // Contact email/cell → display name, for the identifier→person evidence.
  const contactRows = await db
    .select({ title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact')));
  const contactByEmail = new Map<string, string>();
  const contactByPhone = new Map<string, string>();
  for (const c of contactRows) {
    const d = (c.data ?? {}) as Record<string, unknown>;
    if (typeof d.email === 'string' && d.email.trim()) contactByEmail.set(d.email.trim().toLowerCase(), c.title);
    if (typeof d.cell === 'string' && d.cell.replace(/\D/g, '').length >= 7)
      contactByPhone.set(d.cell.replace(/\D/g, ''), c.title);
  }
  const personByLowerName = new Map<string, EntRow>();
  for (const e of ents) if (e.kind === 'person') personByLowerName.set(e.name.trim().toLowerCase(), e);

  // Pairs the operator has rejected — never re-suggest them.
  const dismissedRows = await db
    .select({ lowId: entityMergeDismissals.lowId, highId: entityMergeDismissals.highId })
    .from(entityMergeDismissals)
    .where(eq(entityMergeDismissals.ownerId, ownerId));
  const dismissed = new Set(dismissedRows.map((r) => `${r.lowId}|${r.highId}`));

  const candidates: MergeCandidate[] = [];
  const claimedDup = new Set<string>(); // a dup merges into at most one canonical

  const add = (canonical: EntRow, dup: EntRow, tier: MergeTier, reason: string) => {
    if (canonical.id === dup.id || claimedDup.has(dup.id)) return;
    const [low, high] = orderedPair(canonical.id, dup.id);
    if (dismissed.has(`${low}|${high}`)) return;
    claimedDup.add(dup.id);
    candidates.push({
      canonicalId: canonical.id,
      canonicalName: canonical.name,
      dupId: dup.id,
      dupName: dup.name,
      kind: dup.kind,
      tier,
      reason,
    });
  };

  // AUTO 1 — identifier→person via a matching contact.
  for (const e of ents) {
    if (claimedDup.has(e.id)) continue;
    let personName: string | undefined;
    if (isEmailName(e.name)) personName = contactByEmail.get(e.name.trim().toLowerCase());
    else if (isPhoneName(e.name)) personName = contactByPhone.get(e.name.replace(/\D/g, ''));
    if (!personName) continue;
    const person = personByLowerName.get(personName.trim().toLowerCase());
    if (person && person.id !== e.id) {
      add(person, e, 'auto', `identifier matches contact "${personName}"`);
    }
  }

  // AUTO 2 — org legal-suffix collapse (group orgs by normalised name).
  const orgGroups = new Map<string, EntRow[]>();
  for (const e of ents) {
    if (e.kind !== 'org' || claimedDup.has(e.id)) continue;
    const key = normaliseOrgName(e.name);
    if (!key) continue;
    let g = orgGroups.get(key);
    if (!g) { g = []; orgGroups.set(key, g); }
    g.push(e);
  }
  for (const group of orgGroups.values()) {
    if (group.length < 2) continue;
    // canonical = the strongest in the group
    let canon = group[0]!;
    for (const e of group) [canon] = pickCanonical(canon, e);
    for (const e of group) if (e.id !== canon.id) add(canon, e, 'auto', `same org after legal-suffix strip ("${normaliseOrgName(e.name)}")`);
  }

  // REVIEW 1 — person name token-subset ("Jason" ⊂ "Jason Schoeman").
  const persons = ents.filter((e) => e.kind === 'person' && !claimedDup.has(e.id));
  for (const a of persons) {
    if (claimedDup.has(a.id)) continue;
    let best: EntRow | null = null;
    for (const b of persons) {
      if (a.id === b.id) continue;
      if (isNameSubset(a.name, b.name)) {
        if (!best || b.edgeCount > best.edgeCount) best = b;
      }
    }
    if (best) add(best, a, 'review', `name "${a.name}" is a subset of "${best.name}"`);
  }

  return candidates;
}

// ─── Merge primitive ─────────────────────────────────────────────────────────

/**
 * Merge `dupId` into `canonicalId` for an owner. Re-points every relation/
 * mention edge (source + target) and fact to the canonical, folds the dup's
 * name + aliases into the canonical's aliases (so future extractions resolve
 * the variant straight to the canonical — preventing recurrence), then deletes
 * the dup. Transactional. Returns false if either id is missing / not owned.
 */
export async function mergeEntities(
  ownerId: string,
  canonicalId: string,
  dupId: string,
): Promise<boolean> {
  if (canonicalId === dupId) return false;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(entities)
      .where(and(eq(entities.ownerId, ownerId), or(eq(entities.id, canonicalId), eq(entities.id, dupId))));
    const canon = rows.find((r) => r.id === canonicalId);
    const dup = rows.find((r) => r.id === dupId);
    if (!canon || !dup) return false;

    await tx
      .update(entityEdges)
      .set({ sourceId: canonicalId })
      .where(and(eq(entityEdges.ownerId, ownerId), eq(entityEdges.sourceId, dupId)));
    await tx
      .update(entityEdges)
      .set({ targetId: canonicalId })
      .where(and(eq(entityEdges.ownerId, ownerId), eq(entityEdges.targetId, dupId)));
    await tx
      .update(facts)
      .set({ entityId: canonicalId })
      .where(and(eq(facts.ownerId, ownerId), eq(facts.entityId, dupId)));

    // Fold dup name + aliases into canonical (deduped, excluding the canonical's
    // own name) so future mentions of the variant resolve here.
    const merged = Array.from(
      new Set(
        [...canon.aliases, dup.name, ...dup.aliases]
          .map((a) => a.trim())
          .filter((a) => a && a.toLowerCase() !== canon.name.toLowerCase()),
      ),
    );
    await tx
      .update(entities)
      .set({ aliases: merged, updatedAt: new Date() })
      .where(eq(entities.id, canonicalId));
    await tx.delete(entities).where(and(eq(entities.id, dupId), eq(entities.ownerId, ownerId)));
    return true;
  });
}

/**
 * Record that two entities are NOT duplicates, so the pair is never suggested
 * again. Direction-agnostic (stored as the ordered pair). Idempotent.
 */
export async function dismissMergeCandidate(
  ownerId: string,
  idA: string,
  idB: string,
): Promise<void> {
  if (idA === idB) return;
  const [lowId, highId] = orderedPair(idA, idB);
  await db
    .insert(entityMergeDismissals)
    .values({ ownerId, lowId, highId })
    .onConflictDoNothing();
}
