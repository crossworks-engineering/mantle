/**
 * Pinned-model drift — are the models this brain's agents and workers actually
 * point at still real, and has the family moved on?
 *
 * WHY THIS EXISTS, and how it differs from `models-drift`: that report asks
 * whether our onboarding CATALOGUE offers what providers serve. This one asks
 * the brain-level question nothing answered — whether `agents.model` and
 * `ai_workers.model`, the ids a live turn will actually send, still exist.
 * A pinned model is a decision, not a subscription: it was correct the day it
 * was chosen and nothing ages it. `models-drift` deliberately skips OpenRouter
 * ("cannot drift by construction") which is true of the catalogue and false of
 * a pin — a delisted slug 404s at turn time, and the first sign is a failed
 * conversation.
 *
 * Report-only. Reads rows and public/keyed model lists; writes nothing, invokes
 * no model, spends no tokens.
 *
 * ── The three ways a naive version of this cries wolf ────────────────────────
 *
 * All three were found by writing the naive version first and watching it
 * report a healthy fleet as broken:
 *
 *  1. MODALITY. A provider's list endpoint covers one modality. OpenRouter's
 *     `/models` enumerates chat models only — no tts/stt/whisper id appears in
 *     it at all. Checking a TTS worker against it marks every voice worker
 *     retired. We compare a pin only against catalogue entries of ITS OWN kind,
 *     and report `unchecked` when the catalogue carries nothing of that kind.
 *  2. ALIASES. `~x-ai/grok-latest` is a real, current OpenRouter id — the
 *     tilde is their auto-updating-alias marker. Compare exact strings; never
 *     normalise, strip or "tidy" an id before matching.
 *  3. COVERAGE. A provider with no list API, or one whose key is absent, tells
 *     us nothing. That is `unchecked`, never `missing` — absence of evidence.
 *
 * The cost of a false positive here is worse than a miss: a report that flags
 * healthy pins gets muted, and then the real delisting goes unread too.
 */

/** One model as this brain has it pinned. */
export type PinnedModel = {
  /** Where it is configured — `agent:saskia`, `worker:tts`. Display only. */
  ref: string;
  /** Provider id (`agents.provider` / `ai_workers.provider`). */
  provider: string;
  /** The exact id a turn will send. */
  model: string;
  /** Modality this pin is used for, from the row's own role/kind — NOT from
   *  the catalogue. A tts worker is a tts pin whatever the catalogue thinks. */
  kind: PinKind;
};

/** Modalities a pin can have. Mirrors `ExplorerModel.kind`'s vocabulary so a
 *  pin and a catalogue entry can be compared without a translation table. */
export type PinKind = 'chat' | 'tts' | 'stt' | 'embedding' | 'image' | 'other';

/** The subset of `ExplorerModel` this comparison needs. */
export type CatalogEntry = { id: string; kind?: string };

/** A provider's catalogue as far as we could see it. */
export type ProviderCatalog =
  | { ok: true; entries: CatalogEntry[] }
  /** No list API, no key, or the call failed — we know nothing about this
   *  provider's models and must not conclude anything. */
  | { ok: false; reason: string };

export type DriftVerdict =
  /** The pinned id is absent from a catalogue that DOES cover its kind. This
   *  is the one that breaks turns. */
  | { status: 'missing'; pin: PinnedModel }
  /** Present, but the same family has a higher version. Advisory: a factual
   *  statement about ids, not a claim that the newer one is better. */
  | { status: 'newer-in-family'; pin: PinnedModel; candidates: string[] }
  /** Present and the newest of its family we can see. */
  | { status: 'current'; pin: PinnedModel }
  /** We could not judge it, and why. Never treat as either healthy or broken. */
  | { status: 'unchecked'; pin: PinnedModel; reason: string };

export type PinnedModelDriftResult = {
  checked: number;
  missing: DriftVerdict[];
  newerInFamily: DriftVerdict[];
  current: DriftVerdict[];
  unchecked: DriftVerdict[];
};

/** One line for the maintenance run row. Report-style, like the other drift
 *  sweeps: finding drift is not a failed run, so this summarises rather than
 *  throws. `unchecked` is always stated — a clean-looking report over a
 *  provider we could not reach would be the misleading half of the truth. */
export function summarisePinnedModelDrift(r: PinnedModelDriftResult): string {
  return (
    `${r.checked} pin(s) checked — ${r.missing.length} missing, ` +
    `${r.newerInFamily.length} with a newer family version, ` +
    `${r.current.length} current, ${r.unchecked.length} not checked`
  );
}

/** OpenRouter marks an auto-updating alias with a leading `~`. Such a pin
 *  tracks the family by definition, so "something newer exists" is not a
 *  finding — it is what the operator asked for. */
export function isAliasPin(model: string): boolean {
  return model.startsWith('~');
}

/**
 * Split an id into `{ family, version }` for supersession comparison.
 *
 * `anthropic/claude-opus-4.8` → family `anthropic/claude-opus`, version [4,8].
 * Returns null when there is no trailing dotted-numeric segment, which means
 * the id carries no version we can order — those are reported `current` rather
 * than guessed at.
 *
 * Variant suffixes (`:free`, `:nitro`) are stripped for the family key only;
 * matching against the catalogue always uses the untouched id.
 */
export function parseFamily(model: string): { family: string; version: number[] } | null {
  const base = model.split(':')[0]!;
  const m = /^(.*?)-(\d+(?:\.\d+)*)$/.exec(base);
  if (!m) return null;
  const parts = m[2]!.split('.').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return { family: m[1]!, version: parts };
}

/**
 * Is `a` a higher version than `b`, comparing dot-separated segments as
 * INTEGERS (so `4.20` > `4.5`, the way these vendors number releases — not as
 * a decimal fraction). Stated explicitly because it is the one judgement in
 * here that could reasonably go the other way, and the report says so too.
 */
export function isNewer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Coarse kind for a catalogue entry, defaulting to chat — a provider that
 *  doesn't classify its models is a chat-model list in practice (that is what
 *  every bare-id endpoint returns). */
function entryKind(e: CatalogEntry): string {
  return e.kind ?? 'chat';
}

/**
 * Judge one pin against its provider's catalogue.
 *
 * Order matters: every "we cannot see" case is decided BEFORE any conclusion
 * about the id, so no unreachable provider or uncovered modality can ever
 * produce a `missing`.
 */
export function classifyPin(pin: PinnedModel, catalog: ProviderCatalog): DriftVerdict {
  if (!catalog.ok) return { status: 'unchecked', pin, reason: catalog.reason };

  // Only entries of the pin's own modality are evidence about it.
  const sameKind = catalog.entries.filter((e) => entryKind(e) === pin.kind);
  if (sameKind.length === 0) {
    return {
      status: 'unchecked',
      pin,
      reason: `the catalogue lists no ${pin.kind} models, so it says nothing about this pin`,
    };
  }

  const ids = new Set(sameKind.map((e) => e.id));
  if (!ids.has(pin.model)) return { status: 'missing', pin };

  // Present. An alias already tracks its family, so stop here.
  if (isAliasPin(pin.model)) return { status: 'current', pin };

  const mine = parseFamily(pin.model);
  if (!mine) return { status: 'current', pin };

  const candidates = sameKind
    .filter((e) => !isAliasPin(e.id))
    .map((e) => ({ id: e.id, parsed: parseFamily(e.id) }))
    .filter(
      (c) => c.parsed && c.parsed.family === mine.family && isNewer(c.parsed.version, mine.version),
    )
    .map((c) => c.id)
    .sort();

  return candidates.length > 0
    ? { status: 'newer-in-family', pin, candidates }
    : { status: 'current', pin };
}

/** Judge every pin and bucket the verdicts. Pure — the caller supplies both
 *  the pins and the catalogues, which is what makes this testable without a
 *  database or a network. */
export function classifyPins(
  pins: PinnedModel[],
  catalogs: Map<string, ProviderCatalog>,
): PinnedModelDriftResult {
  const verdicts = pins.map((pin) =>
    classifyPin(pin, catalogs.get(pin.provider) ?? { ok: false, reason: 'provider not fetched' }),
  );
  return {
    checked: pins.length,
    missing: verdicts.filter((v) => v.status === 'missing'),
    newerInFamily: verdicts.filter((v) => v.status === 'newer-in-family'),
    current: verdicts.filter((v) => v.status === 'current'),
    unchecked: verdicts.filter((v) => v.status === 'unchecked'),
  };
}
