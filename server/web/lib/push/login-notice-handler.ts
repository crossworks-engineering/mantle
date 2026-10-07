// The push worker's handler for `login_notice` (migration mobile_roles_push):
// what a member or a client is told about on its phone. Its own module so the
// path from a NOTIFY payload to a send can be tested without the worker
// process (workers/push-notify.ts only wires it to LISTEN).
//
// One notice at a time, in order: a burst cannot open many relay connections
// at once. Each send is bounded (ten devices a login, a capped fan-out, a
// relay timeout), so one event cannot hold the chain for long.

import { parseLoginNotice, type LoginNotice } from '@mantle/content';
import { pgErrorCode } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import type { PushResult } from './notify';
import { pushChatReply, pushComment, pushReviewResult } from './login-notify';

type ReviewNotice = Extract<LoginNotice, { kind: 'review' }>;

/** Accept and Take over change every item of a bundle in ONE transaction, so
 *  their events arrive together at commit: they are gathered for a moment
 *  and sent as one push per author and result. */
export const REVIEW_GATHER_MS = 750;

/** undefined_column, undefined_table: the code is ahead of the schema (a
 *  migration this release needs was not applied). */
const SCHEMA_BEHIND = new Set(['42703', '42P01']);

let schemaWarned = false;
let schemaRepeatAt = 0;
let schemaSkipped = 0;

/** How often, after the loud line, a short line says it is still so. */
export const SCHEMA_REMINDER_MS = 10 * 60 * 1000;

/**
 * Say LOUDLY, once per process, that the database is behind the code. A
 * skipped migration (push_subscriptions.token_id missing) makes every send
 * fail, the admins' too, and a line per event that reads like one bad push
 * is easy to miss. After it, a short line at most every
 * {@link SCHEMA_REMINDER_MS} counts the pushes not sent since, so a log
 * read later still shows the worker is failing.
 */
export function warnIfSchemaBehind(err: unknown, now = Date.now()): boolean {
  if (!SCHEMA_BEHIND.has(pgErrorCode(err) ?? '')) return false;
  if (schemaWarned) {
    schemaSkipped++;
    if (now >= schemaRepeatAt) {
      schemaRepeatAt = now + SCHEMA_REMINDER_MS;
      console.error(
        `[push-notify] still behind the schema: ${schemaSkipped} push(es) not sent so far. ` +
          `Last error: ${errorMessage(err)}`,
      );
    }
  } else {
    schemaWarned = true;
    schemaRepeatAt = now + SCHEMA_REMINDER_MS;
    console.error(
      '[push-notify] THE DATABASE IS BEHIND THE CODE: a table or column the push worker ' +
        'needs is missing, so NO push is being sent (admin pushes too). A migration was ' +
        'not applied (mobile_roles_push adds push_subscriptions.token_id). Run the ' +
        `migrations, then restart this worker. First error: ${errorMessage(err)}`,
    );
  }
  return true;
}

export type LoginNoticeHandler = {
  /** Handle one NOTIFY payload. */
  handle(payload: string): void;
  /** Resolves when everything handled so far was sent (tests, shutdown). */
  idle(): Promise<void>;
};

export function createLoginNoticeHandler(
  opts: {
    gatherMs?: number;
    log?: (line: string) => void;
    /** The sends: stood in by tests. */
    send?: {
      chat: typeof pushChatReply;
      comment: typeof pushComment;
      review: typeof pushReviewResult;
    };
  } = {},
): LoginNoticeHandler {
  const gatherMs = opts.gatherMs ?? REVIEW_GATHER_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const send = opts.send ?? {
    chat: pushChatReply,
    comment: pushComment,
    review: pushReviewResult,
  };
  let chain: Promise<void> = Promise.resolve();
  const timers = new Set<Promise<void>>();
  const pending = new Map<
    string,
    { loginId: string; state: ReviewNotice['state']; ids: Set<string> }
  >();

  const queue = (what: string, run: () => Promise<PushResult>) => {
    chain = chain.then(async () => {
      try {
        const r = await run();
        if (!r.skipped) log(`[push-notify] ${what}: delivered ${r.delivered}/${r.attempted}`);
      } catch (err) {
        if (!warnIfSchemaBehind(err)) {
          console.error(`[push-notify] ${what} send failed:`, errorMessage(err));
        }
      }
    });
  };

  return {
    handle(payload) {
      const n = parseLoginNotice(payload);
      if (!n) return; // malformed: drop rather than crash the listener
      if (n.kind === 'chat') return queue('chat reply', () => send.chat(n));
      if (n.kind === 'comment') return queue('comment', () => send.comment(n.id));
      const key = `${n.loginId}:${n.state}`;
      const waiting = pending.get(key);
      if (waiting) {
        waiting.ids.add(n.id);
        return;
      }
      pending.set(key, { loginId: n.loginId, state: n.state, ids: new Set([n.id]) });
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          const batch = pending.get(key);
          pending.delete(key);
          if (batch) {
            queue(`review ${batch.state}`, () =>
              send.review(batch.loginId, batch.state, [...batch.ids]),
            );
          }
          resolve();
        }, gatherMs);
      });
      timers.add(timer);
      void timer.then(() => timers.delete(timer));
    },
    async idle() {
      while (timers.size) await Promise.all([...timers]);
      await chain;
    },
  };
}
