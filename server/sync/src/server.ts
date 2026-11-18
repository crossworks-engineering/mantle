/**
 * The Sync sidecar's HTTP face (Sync service plan M2).
 *
 *   GET  /health  200 when the rclone binary ran at boot, else 503; compose's
 *                 healthcheck and the updater's "on" wait read it.
 *   GET  /status  what this sidecar is: rclone's version and its providers.
 *
 * The rest only from the brain, with SYNC_TOKEN in `x-mantle-sync-token`:
 *
 *   POST /send       send a message from a linked mailbox (send.ts)
 *   POST /backfill   a new contact's last 90 days of mail, in the background
 *   GET|POST /ui/*   the account screens (ui.ts), through the brain's screen
 *                    route, which adds the base path and a fresh ticket
 *   POST /admin/*    the brain's Sync admin tools (admin.ts)
 *   POST /oauth/*    a Microsoft sign-in, started and finished by the brain
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorMessage } from '@mantle/std';
import { TOKEN_HEADER } from './brain';
import { adminReply } from './admin';
import { backfill, runError } from './mail';
import { sendOutlook } from './outlook';
import { SendRefusedError, outlookSenderFor, senderFor, sendMail, type SendInput } from './send';
import { uiReply, type UiDeps } from './ui';

export type SyncState = {
  /** rclone's version at boot, or null when the binary did not run. */
  rclone: string | null;
};

export type SyncReply = { status: number; body: Record<string, unknown> };

/** The providers this sidecar serves. */
export const PROVIDERS = ['imap', 'ics', 'microsoft'];

/** The answer for /health and /status, pure (the tests call it directly). */
export function syncReply(method: string, path: string, state: SyncState): SyncReply {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
  if (path === '/health') {
    return state.rclone
      ? { status: 200, body: { ok: true } }
      : { status: 503, body: { ok: false, error: 'rclone did not run' } };
  }
  if (path === '/status') {
    return { status: 200, body: { service: 'sync', rclone: state.rclone, providers: PROVIDERS } };
  }
  return { status: 404, body: { error: 'not found' } };
}

/** The largest body taken (a message to send, its attachments in base64). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BASE_RE = /^\/api\/services\/sync\/ui$/;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Whether `req` carries the token. */
export function tokenOk(header: string | string[] | undefined, token: string): boolean {
  const got = typeof header === 'string' ? header : '';
  return !!token && !!got && timingSafeEqual(digest(got), digest(token));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function html(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export type SyncDeps = UiDeps & { token: string };

export function createSyncServer(state: SyncState, deps: SyncDeps | null): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      console.warn(`[sync] ${req.method} request failed: ${errorMessage(err)}`);
      if (!res.headersSent) json(res, 500, { error: 'the Sync service failed' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sync');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/health' || path === '/status') {
      const reply = syncReply(method, path, state);
      return json(res, reply.status, reply.body);
    }
    if (!deps) return json(res, 503, { error: 'the Sync service has no token' });
    if (!tokenOk(req.headers[TOKEN_HEADER], deps.token))
      return json(res, 401, { error: 'unauthorized' });

    if (path === '/send' && method === 'POST') {
      const input = JSON.parse(await readBody(req)) as SendInput;
      let account;
      try {
        const mailboxes = await deps.state.accounts();
        const outlook = outlookSenderFor(await deps.state.msAccounts(), input.from);
        // Outlook when the sender is that account, or when no mailbox sends.
        if (outlook && (input.from || !mailboxes.some((a) => a.enabled && a.smtp))) {
          if (!input.text && !input.html)
            throw new SendRefusedError('A message needs a text or HTML body.');
          await sendOutlook(deps.state, outlook, input);
          return json(res, 200, {
            from: outlook.upn,
            messageId: '',
            accepted: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])],
            rejected: [],
          });
        }
        account = senderFor(mailboxes, input.from);
        return json(res, 200, await sendMail(account, input));
      } catch (err) {
        if (err instanceof SendRefusedError) return json(res, 400, { error: err.message });
        return json(res, 502, { error: `The mail server refused it: ${runError(err, account)}` });
      }
    }
    if (path === '/backfill' && method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { targets?: unknown };
      const targets = Array.isArray(body.targets)
        ? body.targets.filter((t): t is string => typeof t === 'string').slice(0, 100)
        : [];
      if (targets.length > 0)
        void deps.lane.run('backfill', () => backfill(deps.brain, deps.state, targets));
      return json(res, 202, { queued: targets.length });
    }
    if ((path.startsWith('/admin/') || path.startsWith('/oauth/')) && method === 'POST') {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
        body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return json(res, 400, { error: 'send a JSON object' });
      }
      const reply = await adminReply(path, body, deps);
      return json(res, reply.status, reply.body);
    }
    if (path === '/ui' || path.startsWith('/ui/')) {
      const base = String(req.headers['x-mantle-ui-base'] ?? '');
      const ticket = String(req.headers['x-mantle-frame-ticket'] ?? '');
      if (!BASE_RE.test(base) || !ticket)
        return json(res, 400, { error: 'no screen base or ticket' });
      const form =
        method === 'POST' ? new URLSearchParams(await readBody(req)) : new URLSearchParams();
      const originHeader = String(req.headers['x-mantle-ui-origin'] ?? '');
      const origin = /^https?:\/\/[^\s/]{1,300}$/.test(originHeader) ? originHeader : '';
      const reply = await uiReply(
        { method, path: path.slice(3) || '/', form, base, ticket, origin },
        deps,
      );
      return html(res, reply.status, reply.html);
    }
    return json(res, 404, { error: 'not found' });
  }
}
