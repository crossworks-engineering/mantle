/**
 * History read-back suffixes: what an assistant turn actually DID, and what
 * pictures a turn carries, rendered as compact one-line suffixes on history.
 *
 * Moved verbatim out of conversation.ts so the pure context selectors in
 * select.ts can use them without importing conversation.ts back (which builds
 * history FROM them). conversation.ts re-exports both, so every existing
 * importer is unaffected.
 */

// ─── Tool-outcome read-back (context-transfer audit, task 64170cb0) ─────────
// History carries reply text only, so what a turn actually DID — which node it
// wrote, what failed, what's parked behind approval — vanished unless the
// prose restated it. The per-turn toolStats ledger persisted on
// assistant_messages.data (see updateAssistantMessageOutcome) is rendered as a
// compact one-line suffix on outbound history turns. Silent (returns null)
// when the record adds nothing: all-success read-only turns and chat-only
// turns stay byte-identical to before.

const TOOL_RECORD_MAX_FAILURES = 2;
const TOOL_RECORD_MAX_WRITES = 3;
const TOOL_RECORD_ERR_SNIP = 60;

/** Render an outbound turn's persisted toolStats as a `[tool record: …]`
 *  history suffix, or null when there is nothing worth saying. Tolerant of
 *  arbitrary `data` shapes — rows predate the ledger, and other writers own
 *  keys on the same jsonb. */
export function formatToolRecordSuffix(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const stats = (data as { toolStats?: unknown }).toolStats;
  if (stats === null || typeof stats !== 'object') return null;
  const s = stats as {
    calls?: unknown;
    failed?: unknown;
    queued?: unknown;
    failures?: unknown;
    writes?: unknown;
  };
  const calls = typeof s.calls === 'number' ? s.calls : 0;
  const failed = typeof s.failed === 'number' ? s.failed : 0;
  const queued = typeof s.queued === 'number' ? s.queued : 0;
  const writes = Array.isArray(s.writes)
    ? (s.writes as Array<{ id?: unknown; title?: unknown }>).filter(
        (w) => w && typeof w.id === 'string',
      )
    : [];
  if (failed <= 0 && queued <= 0 && writes.length === 0) return null;

  const parts: string[] = [`${calls} tool call${calls === 1 ? '' : 's'} ran`];
  if (failed > 0) {
    const failures = Array.isArray(s.failures)
      ? (s.failures as Array<{ slug?: unknown; error?: unknown }>)
          .filter((f) => f && typeof f.slug === 'string')
          .slice(0, TOOL_RECORD_MAX_FAILURES)
          .map(
            (f) =>
              `${f.slug}${
                typeof f.error === 'string' && f.error
                  ? ` (${f.error.slice(0, TOOL_RECORD_ERR_SNIP)})`
                  : ''
              }`,
          )
      : [];
    parts.push(`${failed} FAILED${failures.length > 0 ? `: ${failures.join(', ')}` : ''}`);
  }
  if (queued > 0) parts.push(`${queued} queued for operator approval, not yet run`);
  if (writes.length > 0) {
    const shown = writes
      .slice(0, TOOL_RECORD_MAX_WRITES)
      .map((w) =>
        typeof w.title === 'string' && w.title
          ? `"${w.title}" (${(w.id as string).slice(0, 8)})`
          : (w.id as string).slice(0, 8),
      );
    const more = writes.length > TOOL_RECORD_MAX_WRITES ? ` +${writes.length - 3} more` : '';
    parts.push(`wrote: ${shown.join(', ')}${more}`);
  }
  return `[tool record: ${parts.join('; ')}]`;
}

// ─── Media read-back ────────────────────────────────────────────────────────
// The twin of the tool-outcome read-back above, for the pictures a turn carried.
// A turn's media lives in `assistant_messages.attachments`, which history never
// replayed — so an image generated on turn 1 was, by turn 2, an object the model
// could see in the transcript UI and not name. It went hunting: two searches
// that couldn't match a fresh file node (no embedding yet, filename is one FTS
// token), then a UUID rebuilt from the 8-char prefix the corpus map prints, and
// a page stored with a dangling reference. Replaying the id costs one short line
// on the turns that have media and nothing at all on the turns that don't.

/** Attachments quoted per turn. Beyond a few, the reply prose is the better
 *  record and the ids stop earning their bytes. */
const MEDIA_RECORD_MAX = 3;
const MEDIA_CAPTION_SNIP = 60;

/** Render a turn's attachments as a `[media record: …]` history suffix, or null
 *  when there is nothing referenceable to say. Tolerant of arbitrary `jsonb`
 *  shapes — the column predates this and other writers own rows in it.
 *
 *  Only attachments carrying a `nodeId` are quoted: that is the id the
 *  `media:<id>` dialect resolves. A transport-only handle (a Telegram
 *  `fileId`) can't be referenced in a page or a reply, so quoting it would
 *  spend tokens on something unusable. */
export function formatMediaRecordSuffix(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;
  const usable = attachments
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a) => typeof a.nodeId === 'string' && a.nodeId.length > 0);
  if (usable.length === 0) return null;

  const shown = usable.slice(0, MEDIA_RECORD_MAX).map((a) => {
    const kind = typeof a.kind === 'string' ? a.kind : 'file';
    const caption = typeof a.caption === 'string' ? a.caption.replace(/\s+/g, ' ').trim() : '';
    const label = caption
      ? ` "${caption.length > MEDIA_CAPTION_SNIP ? `${caption.slice(0, MEDIA_CAPTION_SNIP)}…` : caption}"`
      : '';
    return `${kind}${label} = media:${a.nodeId as string}`;
  });
  const more = usable.length > MEDIA_RECORD_MAX ? ` +${usable.length - MEDIA_RECORD_MAX} more` : '';
  return `[media record: ${shown.join('; ')}${more} — reference these by the id shown, copied whole]`;
}
