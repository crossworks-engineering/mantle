/**
 * Push-notify worker. LISTENs on `conversation_changed` (the trigger from
 * migration 0091, also driving the SSE live stream), `pending_changed`
 * (approvals) and `needs_you_changed` (migration 0186: a member submitted for
 * review or filed a request) and, for every **outbound** turn, seals a teaser
 * to the ADMIN devices and hands it to Mantle Push (push-notifications.md
 * §8/§10). Those three are the owner's side: admin devices only.
 *
 * `login_notice` (migration 0211) is the member's and the client's side: a
 * reply in a login's own chat thread, a review result on its item, a new
 * comment. Each goes to the devices of the ONE login it concerns
 * (lib/push/login-notify.ts). Sends only: nothing here starts LLM work. Its own dedicated LISTEN connection — a
 * separate process from the web app, so it doesn't share the web's in-process
 * realtime bridge.
 *
 * Runs as `pnpm worker:push:dev` locally and the `worker_push` service in prod.
 *
 * The NOTIFY fires twice for a streamed turn: on the 'pending' insert (empty
 * text) and on the finalize update (migration 0156). Only the finished one is
 * pushed — see wantsOutboundPush.
 *
 * NOTE (M2): trigger policy is "push every outbound turn." Foreground
 * suppression (don't notify a device that's actively streaming) is handled
 * client-side in the app (M3/M4) — it drops the local notification when
 * foregrounded. A server-side belt (skip if the device pinged SSE <15s ago) is a
 * later refinement; see §10.
 */
import postgres from 'postgres';
import { PENDING_CHANGED_CHANNEL } from '@mantle/tools';
import {
  LOGIN_NOTICE_CHANNEL,
  NEEDS_YOU_CHANGED_CHANNEL,
  parseLoginNotice,
  type LoginNotice,
} from '@mantle/content';
import { pushApproval, pushNeedsYou, pushOutbound, wantsOutboundPush } from '../lib/push/notify';
import { pushChatReply, pushComment, pushReviewResult } from '../lib/push/login-notify';
import { runWorker } from './_runner';
import { env } from '@mantle/config';

interface ConversationChange {
  ownerId: string;
  agentSlug: string;
  direction: 'inbound' | 'outbound';
  /** Row status (migration 0156); absent from the pre-0156 trigger payload. */
  status?: 'pending' | 'complete' | 'failed';
}

async function handleConversation(payload: string): Promise<void> {
  let c: ConversationChange;
  try {
    c = JSON.parse(payload) as ConversationChange;
  } catch {
    return; // malformed — drop rather than crash the listener
  }
  if (!c?.ownerId || !c?.agentSlug || !wantsOutboundPush(c)) return;

  try {
    const r = await pushOutbound(c.ownerId, c.agentSlug);
    if (!r.skipped) {
      console.log(
        `[push-notify] ${c.agentSlug}: delivered ${r.delivered}/${r.attempted}` +
          (r.dropped ? ` (dropped ${r.dropped} dead)` : ''),
      );
    }
  } catch (err) {
    console.error('[push-notify] send failed:', (err as Error).message);
  }
}

// pending_changed's payload IS the owner id (not JSON) — see @mantle/tools.
async function handlePending(ownerId: string): Promise<void> {
  if (!ownerId) return;
  try {
    const r = await pushApproval(ownerId);
    if (!r.skipped) {
      console.log(`[push-notify] approvals: delivered ${r.delivered}/${r.attempted}`);
    }
  } catch (err) {
    console.error('[push-notify] approval send failed:', (err as Error).message);
  }
}

// "Needs you" (migration 0186): what was pushed, per process, and one
// handler at a time, so a burst of events can never push one arrival twice.
const needsYouSeen = new Set<string>();
let needsYouChain: Promise<void> = Promise.resolve();

function handleNeedsYou(ownerId: string): void {
  if (!ownerId) return;
  needsYouChain = needsYouChain.then(async () => {
    try {
      const r = await pushNeedsYou(ownerId, needsYouSeen);
      if (!r.skipped) {
        console.log(`[push-notify] needs-you: delivered ${r.delivered}/${r.attempted}`);
      }
    } catch (err) {
      console.error('[push-notify] needs-you send failed:', (err as Error).message);
    }
  });
}

// Member and client notices (migration 0211). One at a time, in order, so a
// burst cannot open many relay connections at once.
let loginChain: Promise<void> = Promise.resolve();
const queueLogin = (
  what: string,
  run: () => Promise<{ skipped?: string; delivered: number; attempted: number }>,
) => {
  loginChain = loginChain.then(async () => {
    try {
      const r = await run();
      if (!r.skipped) console.log(`[push-notify] ${what}: delivered ${r.delivered}/${r.attempted}`);
    } catch (err) {
      console.error(`[push-notify] ${what} send failed:`, (err as Error).message);
    }
  });
};

// Accept and Take over change every item of a bundle in ONE transaction, so
// their events arrive together at commit: they are gathered for a moment and
// sent as one push per author and result.
const REVIEW_GATHER_MS = 750;
type ReviewNotice = Extract<LoginNotice, { kind: 'review' }>;
const reviewPending = new Map<
  string,
  { loginId: string; state: ReviewNotice['state']; ids: Set<string> }
>();

function handleLoginNotice(payload: string): void {
  const n = parseLoginNotice(payload);
  if (!n) return; // malformed: drop rather than crash the listener
  if (n.kind === 'chat') return queueLogin('chat reply', () => pushChatReply(n));
  if (n.kind === 'comment') return queueLogin('comment', () => pushComment(n.id));
  const key = `${n.loginId}:${n.state}`;
  const waiting = reviewPending.get(key);
  if (waiting) {
    waiting.ids.add(n.id);
    return;
  }
  reviewPending.set(key, { loginId: n.loginId, state: n.state, ids: new Set([n.id]) });
  setTimeout(() => {
    const batch = reviewPending.get(key);
    reviewPending.delete(key);
    if (!batch) return;
    queueLogin(`review ${batch.state}`, () =>
      pushReviewResult(batch.loginId, batch.state, [...batch.ids]),
    );
  }, REVIEW_GATHER_MS);
}

// This worker is a pure LISTEN loop with no business tick, so the runner's
// heartbeat measures event-loop liveness — exactly the health signal we want.
runWorker('push-notify', async () => {
  const url = env('DATABASE_URL')!;
  // Needed to decrypt the instance token at rest (@mantle/crypto).
  if (!env('MANTLE_MASTER_KEY')) throw new Error('MANTLE_MASTER_KEY must be set');

  console.log(
    '[push-notify] listening on conversation_changed + pending_changed + needs_you_changed + login_notice',
  );
  const sql = postgres(url, { max: 1, prepare: false });
  const subConversation = await sql.listen('conversation_changed', (payload) => {
    void handleConversation(payload);
  });
  const subPending = await sql.listen(PENDING_CHANGED_CHANNEL, (ownerId) => {
    void handlePending(ownerId);
  });

  const subNeedsYou = await sql.listen(NEEDS_YOU_CHANGED_CHANNEL, handleNeedsYou);
  const subLogin = await sql.listen(LOGIN_NOTICE_CHANNEL, handleLoginNotice);

  return async () => {
    try {
      await subConversation.unlisten();
      await subPending.unlisten();
      await subNeedsYou.unlisten();
      await subLogin.unlisten();
      await sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  };
});
