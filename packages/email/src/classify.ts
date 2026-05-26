/**
 * Delivery-kind classifier — `direct | list | automated | marketing`.
 *
 * Pure, no IO, no LLM. Given the headers + sender + IMAP/Gmail labels we
 * already fetch on the cheap `listSince` path, decide which of four buckets
 * the message belongs in. Designed so it can run *before* a body has been
 * fetched — pending senders are exactly the case the senders-page pill cares
 * about, and they have no body in the DB yet.
 *
 * The rule cascade is first-match-wins, ordered by confidence:
 *
 *   1. Gmail `CATEGORY_PROMOTIONS` label → `marketing` (Gmail already
 *      classified it for us; free signal when available).
 *   2. `marketing` — RFC 8058 one-click unsubscribe, `Precedence: bulk`,
 *      `Feedback-ID`, or an ESP fingerprint + `List-Unsubscribe`
 *      (and *not* `Auto-Submitted`, which would mean a transactional send
 *      from the same ESP).
 *   3. `list` — `List-ID` header, or `Precedence: list`.
 *   4. `automated` — `Auto-Submitted` ≠ no, `Precedence: auto_reply`,
 *      `noreply@`-style local part, or a residual `List-Unsubscribe`
 *      (the transactional-mail catch — receipts, password resets).
 *   5. `direct` — none of the above (a human writing to you, probably).
 *
 * The dominance + threshold knobs that decide whether the *sender* gets
 * a pill live in the UI consumer (see `dominantKind` on /settings/senders),
 * not here — this function classifies a single message and is deterministic.
 *
 * The Gmail `\Important` label is *not* used: per spec it was a low-priority
 * tiebreak only — i.e. only when no other rule fired, which is exactly the
 * case where we already return `direct`. So it would be a no-op; we omit
 * the check to keep the cascade honest.
 */

export type DeliveryKind = 'direct' | 'list' | 'automated' | 'marketing';

export interface ClassifyInput {
  /**
   * Header map with **lower-cased keys** and string values. Multi-value
   * headers (rare in the marketing-tell set) should collapse to the first
   * occurrence — that matches how `parseHeaderBlock` in the IMAP provider
   * surfaces them.
   */
  headers: Record<string, string>;
  /** Lower-cased sender address (`From:` envelope). Used for the noreply
   *  local-part heuristic. */
  fromAddr: string;
  /**
   * Merged IMAP `\Flags` + Gmail `X-GM-LABELS` for the message. Case
   * preserved as the server sent it — we do case-insensitive comparison
   * inside. Optional; absent means "no Gmail labels, classify from headers
   * alone".
   */
  labels?: string[];
}

/** Header names whose mere presence on an ESP-routed send signals bulk.
 *  Lower-cased. Combined with `List-Unsubscribe` + absence of
 *  `Auto-Submitted` to avoid catching transactional mail from the same
 *  providers (Stripe via SendGrid, GitHub via SES, etc.). */
const ESP_FINGERPRINT_HEADERS = [
  // Mailchimp
  'x-mc-user',
  'x-mailchimp-campaign-id',
  // SendGrid
  'x-sg-eid',
  'x-sg-id',
  // Mailgun
  'x-mailgun-sid',
  'x-mailgun-variables',
  // Amazon SES
  'x-ses-outgoing',
  // Postmark
  'x-pm-message-id',
  // HubSpot
  'x-hs-marketing-email',
  'x-hubspot-campaign-id',
  // ConvertKit
  'x-ck-domain',
  // Campaign Monitor
  'x-cmail-recipientid',
  // ActiveCampaign
  'x-activecampaign-id',
  // Klaviyo
  'x-klaviyo-message-id',
  // MessageBird
  'x-mb-mailer',
  // Iterable
  'x-iterable-campaign-id',
  // Customer.io
  'x-cio-delivery-id',
] as const;

/** Local-part markers indicating an unattended mailbox. Matched as a whole
 *  token at the start of the local part, with the usual separators
 *  (`-`, `_`, `.`, `+`) — so `noreply@x` and `no-reply@x` and
 *  `notifications-pr-123@x` all match, but `notify-me@x` (human) does not
 *  collide with the `notification` token because `me` isn't a separator. */
const NOREPLY_MARKERS = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'bounce',
  'bounces',
  'mailer-daemon',
  'postmaster',
  'notification',
  'notifications',
] as const;

const NOREPLY_SEPARATORS = ['-', '_', '.', '+'] as const;

function isNoreplyLocalPart(local: string): boolean {
  const lower = local.toLowerCase();
  for (const marker of NOREPLY_MARKERS) {
    if (lower === marker) return true;
    for (const sep of NOREPLY_SEPARATORS) {
      if (lower.startsWith(marker + sep)) return true;
    }
  }
  return false;
}

function localPartOf(addr: string): string {
  const at = addr.indexOf('@');
  return at < 0 ? addr : addr.slice(0, at);
}

function hasLabel(labels: string[] | undefined, name: string): boolean {
  if (!labels) return false;
  const want = name.toLowerCase();
  for (const l of labels) if (l.toLowerCase() === want) return true;
  return false;
}

function headerLower(headers: Record<string, string>, name: string): string | undefined {
  const v = headers[name];
  return v ? v.toLowerCase().trim() : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const v = headers[name];
  return typeof v === 'string' && v.length > 0;
}

function matchesAnyEspFingerprint(headers: Record<string, string>): boolean {
  for (const name of ESP_FINGERPRINT_HEADERS) {
    if (hasHeader(headers, name)) return true;
  }
  return false;
}

/** Classify one message. See file-level comment for the rule cascade. */
export function classifyDelivery(input: ClassifyInput): DeliveryKind {
  const { headers, fromAddr, labels } = input;

  // Gmail's own classifier — when it's labelled the message Promotions
  // we trust it. Free, no header parsing required.
  if (hasLabel(labels, 'CATEGORY_PROMOTIONS')) return 'marketing';

  const precedence = headerLower(headers, 'precedence');
  const autoSubmitted = headerLower(headers, 'auto-submitted');
  const isAutoSubmitted = autoSubmitted !== undefined && autoSubmitted !== 'no';

  // ── 1. marketing ──────────────────────────────────────────────────────
  // RFC 8058 one-click unsubscribe — Gmail/Yahoo now require this for
  // senders pushing >5K msgs/day, so it's a near-perfect bulk tell.
  const listUnsubPost = headerLower(headers, 'list-unsubscribe-post');
  if (listUnsubPost && /one-click/i.test(listUnsubPost)) return 'marketing';

  if (precedence === 'bulk') return 'marketing';
  if (hasHeader(headers, 'feedback-id')) return 'marketing';

  if (
    matchesAnyEspFingerprint(headers) &&
    hasHeader(headers, 'list-unsubscribe') &&
    !isAutoSubmitted
  ) {
    return 'marketing';
  }

  // ── 2. list ────────────────────────────────────────────────────────────
  if (hasHeader(headers, 'list-id')) return 'list';
  if (precedence === 'list') return 'list';

  // ── 3. automated ───────────────────────────────────────────────────────
  if (isAutoSubmitted) return 'automated';
  if (precedence === 'auto_reply') return 'automated';
  if (isNoreplyLocalPart(localPartOf(fromAddr))) return 'automated';

  // Residual catch — receipts, password resets, transactional mail that
  // doesn't set Auto-Submitted but does carry a List-Unsubscribe so the
  // recipient has a kill switch. Distinct from `marketing` because there's
  // no ESP fingerprint AND no Precedence: bulk AND no one-click marker.
  if (hasHeader(headers, 'list-unsubscribe')) return 'automated';

  // ── 4. direct ──────────────────────────────────────────────────────────
  return 'direct';
}
