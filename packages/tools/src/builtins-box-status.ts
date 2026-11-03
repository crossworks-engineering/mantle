/**
 * Builtins: box_status and peer_status, the fleet monitor's two reads
 * (docs/federation.md "Status links").
 *
 * box_status reports this box as numbers: build, process, host, Postgres,
 * the services, spend, capacity, the extractor's queue and the logins. The
 * collectors live in server/web and reach this package through the box
 * status bridge (box-status-bridge.ts), so a process without them refuses
 * clearly.
 *
 * peer_status asks each watched peer for its box_status over the peer's
 * MCP endpoint, all at once, each with its own deadline, and adds this box's
 * own line. It never calls anything but box_status, never takes a URL, and
 * holds every reply to schema 1's shape (shapeBoxStatus) before a model
 * reads it.
 *
 * A status-only peer reaches box_status and brain_capacity and nothing else
 * (status-surface.ts STATUS_PEER_TOOL_SLUGS): the gate's peer narrower
 * refuses any other tool for one (gate-narrowers.ts), and /api/mcp registers
 * only those for it (@mantle/mcp-core).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getOutboundToken, listPeers, markPeerContacted, peerCallTarget } from '@mantle/content';
import { errorMessage } from '@mantle/std';
import { areaSystem } from './admin-gate';
import {
  BOX_STATUS_UNAVAILABLE,
  getBoxStatusProvider,
  shapeBoxStatus,
  type BoxStatus,
} from './box-status-bridge';
import { peerMcpFetchCapped } from './builtins-peer-mcp';
import { strOpt } from './coerce';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

/** How long one peer has to answer, from connect to reply. */
export const PEER_STATUS_TIMEOUT_MS = 10_000;

/** How many peers are asked at once; the rest wait for a free place. */
export const PEER_STATUS_CONCURRENCY = 8;

/** The most watched peers one call asks (by name); the rest are counted in
 *  `skipped`. */
export const PEER_STATUS_MAX_PEERS = 64;

/** The whole call's limit: a peer not answered by then is a `timeout`, one
 *  not yet asked too. */
export const PEER_STATUS_OVERALL_MS = 45_000;

/** The most one peer's box_status reply may carry (a status is a few KB). */
export const PEER_STATUS_REPLY_MAX_BYTES = 256 * 1024;

/** The fetch peer_status's transport runs on: the peer tools' egress fetch,
 *  with the reply capped at PEER_STATUS_REPLY_MAX_BYTES. */
const peerStatusFetch = peerMcpFetchCapped(PEER_STATUS_REPLY_MAX_BYTES);

/** This box's status, collected on the system pool after the settings area
 *  check (whole-box numbers, as brain_capacity's counts), or the refusal of
 *  a process without the collectors. */
async function ownStatus(ownerId: string): Promise<BoxStatus | { error: string }> {
  const collect = getBoxStatusProvider();
  if (!collect) return { error: BOX_STATUS_UNAVAILABLE };
  return areaSystem('settings', () => collect(ownerId));
}

export const box_status: BuiltinToolDef = {
  slug: 'box_status',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'Check box status',
  description:
    "This box's health as numbers only (schema 1): build version, process uptime and memory, host CPU load, load average, cores, memory and disk, Postgres size, connections and cache hit, each service up or down (object store, parser with its running and queued counts, browser, documents, embedder, sandboxes, network), model spend in micro-USD over the last 24 hours, 7 and 30 days with the last day's trace, turn and error counts, corpus capacity against the split policy, the extractor's queue and dead letters, and logins by role. `degraded` names the probes that did not answer. Never a name, a title or anything a user wrote. Cached for 30 seconds. Read-only, spends nothing.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const status = await ownStatus(ctx.ownerId);
    if ('error' in status) return { ok: false, error: status.error };
    const shaped = shapeBoxStatus(status);
    if (!shaped) return { ok: false, error: 'This box gave no status of schema 1.' };
    ctx.step?.setMeta({ degraded: shaped.degraded.length });
    return { ok: true, output: shaped };
  },
};

/** One box's line in peer_status. `error` is one of a few fixed words, so a
 *  peer's reply text never reaches it. */
export type PeerStatusLine = ({ self: true } | { peerId: string; name: string }) &
  ({ ok: true; ms: number; status: unknown } | { ok: false; ms: number; error: string });

/** Why a peer gave no status, in a few fixed words. */
export type PeerStatusError =
  | 'timeout'
  | 'unreachable'
  | 'refused'
  | 'not offered'
  | 'failed'
  | 'bad reply'
  | 'not paired'
  | 'unavailable';

class StatusError extends Error {
  constructor(readonly kind: PeerStatusError) {
    super(kind);
  }
}

/** The fixed word for a failed peer call (pure). */
export function peerStatusErrorOf(err: unknown): PeerStatusError {
  if (err instanceof StatusError) return err.kind;
  const msg = errorMessage(err);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(msg)) return 'refused';
  if (/not found|unknown tool|-32601|-32602/i.test(msg)) return 'not offered';
  if (/timed? ?out|timeout|abort/i.test(msg)) return 'timeout';
  return 'unreachable';
}

/**
 * Run each job with its own deadline, at most `concurrency` at once (the
 * rest wait for a free place; a job's deadline starts when it starts), and
 * all of them within `overallMs`: a job's deadline never runs past it, and a
 * job not started by then is not started. A job past its deadline is a
 * `timeout` whatever it does after (its signal is aborted, so it can stop).
 * Never throws: each job's answer is its value or its fixed error, in the
 * jobs' order. Exported for the timeout tests.
 */
export async function runWithDeadlines<K>(
  jobs: ReadonlyArray<{ key: K; run: (signal: AbortSignal) => Promise<unknown> }>,
  timeoutMs: number,
  concurrency = PEER_STATUS_CONCURRENCY,
  overallMs = PEER_STATUS_OVERALL_MS,
): Promise<
  Array<
    { key: K; ms: number } & ({ ok: true; value: unknown } | { ok: false; error: PeerStatusError })
  >
> {
  type Answer = { key: K; ms: number } & (
    { ok: true; value: unknown } | { ok: false; error: PeerStatusError }
  );
  const endAt = Date.now() + overallMs;
  const one = async ({
    key,
    run,
  }: {
    key: K;
    run: (signal: AbortSignal) => Promise<unknown>;
  }): Promise<Answer> => {
    const started = Date.now();
    const limit = Math.min(timeoutMs, endAt - started);
    if (limit <= 0) return { key, ms: 0, ok: false as const, error: 'timeout' };
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new StatusError('timeout'));
      }, limit);
    });
    try {
      const value = await Promise.race([run(ctl.signal), deadline]);
      return { key, ms: Date.now() - started, ok: true as const, value };
    } catch (err) {
      return { key, ms: Date.now() - started, ok: false as const, error: peerStatusErrorOf(err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const out: Answer[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await one(jobs[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker),
  );
  return out;
}

/** box_status on one peer's MCP endpoint, with the token we call it with:
 *  its reply held to numbers. The transport is the peer tools' egress fetch
 *  (peerMcpFetch: every hop checked, the token dropped on a hop to another
 *  origin), the URL the peer row's own. */
async function peerBoxStatus(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, signal },
    fetch: peerStatusFetch,
  });
  const client = new Client({ name: 'mantle-peer-status', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: timeoutMs, signal });
    const res = (await client.callTool(
      { name: 'box_status', arguments: {} },
      { timeout: timeoutMs, signal },
    )) as { content?: unknown; isError?: unknown };
    const parts = Array.isArray(res.content) ? res.content : [];
    const text = parts
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
      )
      .join('');
    if (res.isError) {
      throw new StatusError(/not found|unknown tool/i.test(text) ? 'not offered' : 'failed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StatusError('bad reply');
    }
    const shaped = shapeBoxStatus(parsed);
    if (!shaped) throw new StatusError('bad reply');
    return shaped;
  } finally {
    await client.close().catch(() => {});
  }
}

type Target = { peerId: string; name: string; baseUrl: string; token: string | null };

export const peer_status: BuiltinToolDef = {
  slug: 'peer_status',
  policy: {
    effect: 'read',
    spends: 'none',
    scope: { area: 'settings' },
    // Reaches the linked brains, and what they send is theirs: held to
    // numbers, and fenced as data all the same.
    outside: { via: 'peer', untrusted: true },
    peerRisky: true,
  },
  name: 'Check the status of watched boxes',
  description:
    "Ask every watched linked brain (a peer marked to watch, paired and enabled; the first 64 by name, the rest counted in `skipped`) for its box_status, eight at a time, each given 10 seconds and all within 45, plus this box's own (`self: true`). Pass `peer` (a name or id) to ask one linked brain only. Returns one line per box: `ok`, `ms`, and the status numbers or a short error ('timeout', 'unreachable', 'refused', 'not offered', 'failed', 'bad reply', 'not paired'; this box's own line 'unavailable' in a process that cannot collect it). Numbers only. Calls box_status and nothing else. Read-only, spends nothing.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: {
        type: 'string',
        maxLength: 200,
        description: "One linked brain's name or id (see `peer_list`); omit for every watched one.",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const ref = strOpt(input.peer)?.trim();
    let skipped = 0;
    // The peer rows and their tokens are system tables of the connectors
    // area (as the peer tools read them).
    const targets: Target[] = await areaSystem('connectors', async () => {
      if (ref) {
        const t = await peerCallTarget(ctx.ownerId, ref);
        if ('error' in t) return [];
        return [
          { peerId: t.peer.id, name: t.peer.displayName, baseUrl: t.peer.baseUrl, token: t.token },
        ];
      }
      const watched = (await listPeers(ctx.ownerId))
        .filter((p) => p.watchStatus && p.enabled && p.status === 'active' && p.hasOutboundToken)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      skipped = Math.max(0, watched.length - PEER_STATUS_MAX_PEERS);
      return Promise.all(
        watched.slice(0, PEER_STATUS_MAX_PEERS).map(async (p) => ({
          peerId: p.id,
          name: p.displayName,
          baseUrl: p.baseUrl,
          token: await getOutboundToken(ctx.ownerId, p.id),
        })),
      );
    });
    if (ref && targets.length === 0) {
      return {
        ok: false,
        error: `No paired, enabled peer matches "${ref.slice(0, 100)}". Use peer_list to see the peers.`,
      };
    }
    const jobs = [
      {
        key: null as Target | null,
        run: async () => {
          const own = await ownStatus(ctx.ownerId);
          if ('error' in own) throw new StatusError('unavailable');
          const shaped = shapeBoxStatus(own);
          if (!shaped) throw new StatusError('bad reply');
          return shaped;
        },
      },
      ...targets.map((t) => ({
        key: t as Target | null,
        run: (signal: AbortSignal) => {
          if (!t.token) return Promise.reject(new StatusError('not paired'));
          return peerBoxStatus(t.baseUrl, t.token, signal, PEER_STATUS_TIMEOUT_MS);
        },
      })),
    ];
    const answers = await runWithDeadlines(jobs, PEER_STATUS_TIMEOUT_MS);
    const boxes: PeerStatusLine[] = answers.map((a) => {
      const who = a.key ? { peerId: a.key.peerId, name: a.key.name } : { self: true as const };
      return a.ok
        ? { ...who, ok: true, ms: a.ms, status: a.value }
        : { ...who, ok: false, ms: a.ms, error: a.error };
    });
    // A peer that answered was contacted: the peers screen's note.
    const answered = answers.filter((a) => a.key && a.ok).map((a) => a.key!.peerId);
    if (answered.length > 0) {
      await areaSystem('connectors', async () => {
        for (const id of answered) await markPeerContacted(ctx.ownerId, id);
      }).catch(() => {});
    }
    ctx.step?.setMeta({ boxes: boxes.length, ok: boxes.filter((b) => b.ok).length, skipped });
    return {
      ok: true,
      output: skipped > 0 ? { boxes, skipped } : { boxes },
      untrusted: true,
    };
  },
};

export const FLEET_STATUS_TOOLS: readonly BuiltinToolDef[] = [box_status, peer_status];
