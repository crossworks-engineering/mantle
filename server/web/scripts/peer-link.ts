/**
 * Link two boxes from their shells, with no password and no UI: the status
 * link of the fleet monitor (docs/federation.md "Status links").
 *
 * Runs INSIDE the web container; on a box, use the wrapper:
 *
 *   scripts/peer-link.sh create --name admin --url https://admin.example.com --status-only
 *   scripts/peer-link.sh accept --peer box1 < their-token.txt
 *
 * Here, directly (dev, or `docker compose exec web ...`):
 *
 *   pnpm -C server/web peer-link <command> [flags]
 *
 * Shell access to the box proves ownership, as with scripts/onboard.sh: the
 * peers it makes are the brain owner's. Commands:
 *
 *   create --name <n> --url <https://...> [--status-only | --outbound-only] [--watch] [--allow-http]
 *       A new peer. Prints `peer_id=<id>` and, unless --outbound-only, this
 *       side's new inbound token ONCE as `token=<token>` (hand it to the
 *       other box). --status-only: that token lists and calls box_status and
 *       brain_capacity and nothing else. --outbound-only: no usable inbound
 *       token at all (the watching side). --watch: peer_status polls it.
 *       The URL must be https; --allow-http takes plain http, for a local
 *       test only (the token would travel unencrypted).
 *   accept --peer <id|name> [--token-file <path>]
 *       Store the OTHER box's token (from the file, else stdin) and make the
 *       peer active. Never from argv.
 *   list [--json]
 *       Every peer, no secrets.
 *   revoke --peer <id|name>
 *       Disable the peer: both directions stop.
 *
 * Every change leaves an audit row (peer.linked, peer.accepted,
 * peer.revoked), as the peers routes' writes do. Tokens are never printed
 * except the one `token=` line of a create, never logged and never audited.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PEER_TOKEN_PREFIX,
  createPeer,
  listPeers,
  setOutboundToken,
  setPeerEnabled,
  type PeerAccessScope,
  type PeerRow,
} from '@mantle/content';
import { resolveSingleOwnerId, runAsSystem } from '@mantle/db';
import { logAudit } from '../lib/audit';

export type Command = 'create' | 'accept' | 'list' | 'revoke';

export type Options = {
  command: Command | null;
  name?: string;
  url?: string;
  peer?: string;
  tokenFile?: string;
  statusOnly: boolean;
  outboundOnly: boolean;
  watch: boolean;
  allowHttp: boolean;
  json: boolean;
  help: boolean;
};

const COMMANDS: readonly Command[] = ['create', 'accept', 'list', 'revoke'];

const VALUE_FLAGS: Record<string, 'name' | 'url' | 'peer' | 'tokenFile'> = {
  '--name': 'name',
  '--url': 'url',
  '--peer': 'peer',
  '--token-file': 'tokenFile',
};

/** Flags that would put a token in argv. Refused by name, with the way to do it. */
const SECRET_FLAGS = ['--token', '--inbound-token', '--outbound-token', '--secret'];

/** The arguments (pure). Throws with a message for the operator. */
export function parseArgs(argv: string[]): Options {
  const o: Options = {
    command: null,
    statusOnly: false,
    outboundOnly: false,
    watch: false,
    allowHttp: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const [flag, inline] = raw.includes('=')
      ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
      : [raw, undefined];
    if (SECRET_FLAGS.includes(flag)) {
      throw new Error(
        `${flag} is refused: a token never goes on the command line (shell history, ps). ` +
          'Pipe it on stdin, or name a file with --token-file.',
      );
    }
    if (flag === '--help' || flag === '-h') o.help = true;
    else if (flag === '--status-only') o.statusOnly = true;
    else if (flag === '--outbound-only') o.outboundOnly = true;
    else if (flag === '--watch') o.watch = true;
    else if (flag === '--allow-http') o.allowHttp = true;
    else if (flag === '--json') o.json = true;
    else if (flag in VALUE_FLAGS) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw new Error(`${flag} needs a value.`);
      o[VALUE_FLAGS[flag]!] = value;
    } else if (!flag.startsWith('-') && o.command === null) {
      if (!(COMMANDS as readonly string[]).includes(flag)) {
        throw new Error(`Unknown command: ${flag.slice(0, 40)} (create, accept, list or revoke).`);
      }
      o.command = flag as Command;
    } else {
      throw new Error(`Unknown argument: ${raw.slice(0, 40)} (try --help)`);
    }
  }
  if (o.help) return o;
  if (!o.command) throw new Error('Name a command: create, accept, list or revoke (try --help).');
  if (o.statusOnly && o.outboundOnly) {
    throw new Error('--status-only and --outbound-only do not go together: pick one.');
  }
  if (o.command === 'create') {
    if (!o.name?.trim()) throw new Error('create needs --name.');
    if (!o.url?.trim()) throw new Error('create needs --url.');
    const url = o.url.trim();
    if (/^http:\/\//i.test(url) && !o.allowHttp) {
      throw new Error(
        'The URL is plain http: the token would travel unencrypted. Use https, or --allow-http for a local test.',
      );
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('--url must start with https://.');
  } else if (o.statusOnly || o.outboundOnly || o.watch || o.allowHttp) {
    throw new Error('--status-only, --outbound-only, --watch and --allow-http are for create.');
  }
  if ((o.command === 'accept' || o.command === 'revoke') && !o.peer?.trim()) {
    throw new Error(`${o.command} needs --peer (an id or a name from list).`);
  }
  if (o.tokenFile && o.command !== 'accept') throw new Error('--token-file is for accept.');
  return o;
}

/** The access scope a create asks for. */
export function scopeOf(o: Pick<Options, 'statusOnly' | 'outboundOnly'>): PeerAccessScope {
  return o.statusOnly ? 'status' : o.outboundOnly ? 'none' : 'full';
}

/**
 * The other box's token from what was piped or read (pure): the `token=`
 * line of a create's output when there is one (so the whole output may be
 * piped across), else its first non-empty line, trimmed. It must look like
 * a peer token. The error never repeats the input.
 */
export function tokenFromText(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0);
  const line = lines.find((l) => l.startsWith('token=')) ?? lines[0];
  if (!line) throw new Error('No token given: pipe it on stdin or name a file with --token-file.');
  const token = line.startsWith('token=') ? line.slice('token='.length).trim() : line;
  if (!token.startsWith(PEER_TOKEN_PREFIX) || /\s/.test(token) || token.length > 512) {
    throw new Error(
      `That is not a peer token (one starts with ${PEER_TOKEN_PREFIX}); its content is not shown.`,
    );
  }
  return token;
}

/** A peer by id, or by name (case-insensitive), or an error (pure). */
export function findPeer(peers: readonly PeerRow[], ref: string): PeerRow | { error: string } {
  const trimmed = ref.trim();
  const byId = peers.find((p) => p.id === trimmed);
  if (byId) return byId;
  const named = peers.filter((p) => p.displayName.toLowerCase() === trimmed.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return { error: `More than one peer is named "${trimmed}": use its id.` };
  return { error: `No peer "${trimmed}" (see: list).` };
}

const HELP = `Link boxes from the shell: the fleet monitor's status link.

  scripts/peer-link.sh <command> [flags]     on a box (runs this in the web container)
  pnpm -C server/web peer-link <command>     in a checkout

Commands:
  create --name <n> --url <https://...> [--status-only | --outbound-only] [--watch]
         Prints peer_id=... and, unless --outbound-only, token=... ONCE.
         --status-only   that token reaches box_status and brain_capacity only
         --outbound-only this box takes no calls from the peer (the watching side)
         --watch         peer_status polls this peer
         --allow-http    take a plain http URL (a local test only)
  accept --peer <id|name> [--token-file <path>]
         The other box's token, from the file or stdin (never an argument).
  list [--json]
  revoke --peer <id|name>

A watched box and the admin box that watches it:
  watched$ scripts/peer-link.sh create --name admin --url https://admin.example.com --status-only
  admin$   scripts/peer-link.sh create --name box1 --url https://box1.example.com --outbound-only --watch
  admin$   scripts/peer-link.sh accept --peer box1 --token-file ./box1-token
`;

/** Where a run writes: stdout for the machine-readable lines, stderr for
 *  notes. A test stands in for both. */
export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: () => Promise<string>;
};

/** The brain owner, whose peers these are. */
async function anchor(): Promise<string> {
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) throw new Error('This brain has no owner yet: run scripts/onboard.sh first.');
  return ownerId;
}

async function audit(
  action: 'peer.linked' | 'peer.accepted' | 'peer.revoked',
  peer: PeerRow,
): Promise<void> {
  await logAudit({
    actorId: null,
    actorEmail: 'shell (peer-link)',
    action,
    method: 'CLI',
    path: 'scripts/peer-link.sh',
    detail: {
      peerId: peer.id,
      accessScope: peer.accessScope,
      watchStatus: peer.watchStatus,
    },
  });
}

/** One command, on the database. Returns the exit code. */
export async function run(o: Options, io: Io): Promise<number> {
  if (o.help) {
    io.out(HELP);
    return 0;
  }
  return runAsSystem('cli:peer-link', async () => {
    const ownerId = await anchor();
    const peers = await listPeers(ownerId);

    if (o.command === 'list') {
      if (o.json) {
        io.out(JSON.stringify(peers, null, 2));
        return 0;
      }
      if (peers.length === 0) io.err('No peers.');
      for (const p of peers) {
        io.out(
          [
            `peer_id=${p.id}`,
            `name=${JSON.stringify(p.displayName)}`,
            `url=${p.baseUrl}`,
            `status=${p.enabled ? p.status : 'disabled'}`,
            `access=${p.accessScope ?? 'unknown'}`,
            `watch=${p.watchStatus ? 'yes' : 'no'}`,
            `outbound=${p.hasOutboundToken ? 'yes' : 'no'}`,
            `acts_as=${p.actsAsLoginId ? 'login' : 'none'}`,
            `last_seen=${p.lastSeenAt ?? '-'}`,
            `last_contacted=${p.lastContactedAt ?? '-'}`,
          ].join(' '),
        );
      }
      return 0;
    }

    if (o.command === 'create') {
      const name = o.name!.trim();
      if (peers.some((p) => p.displayName.toLowerCase() === name.toLowerCase())) {
        io.err(`A peer is already named "${name}": pick another name, or revoke that one.`);
        return 1;
      }
      const url = o.url!.trim();
      if (/^http:\/\//i.test(url)) {
        io.err('Note: --allow-http: the token travels unencrypted. For a local test only.');
      }
      const scope = scopeOf(o);
      const created = await createPeer(ownerId, {
        displayName: name,
        baseUrl: url,
        createdBy: ownerId,
        accessScope: scope,
        watchStatus: o.watch,
      });
      await audit('peer.linked', created.peer);
      io.out(`peer_id=${created.peer.id}`);
      if (scope === 'none') {
        io.err('Outbound only: this box takes no calls from that peer. Accept its token next.');
      } else {
        // The one time the token is shown: the other box needs it.
        io.out(`token=${created.inboundToken}`);
        io.err(
          scope === 'status'
            ? "Hand the token to the other box (accept there). It reads this box's status only."
            : 'Hand the token to the other box (accept there).',
        );
      }
      return 0;
    }

    const found = findPeer(peers, o.peer!);
    if ('error' in found) {
      io.err(found.error);
      return 1;
    }

    if (o.command === 'accept') {
      if (!found.enabled) {
        io.err(`Peer "${found.displayName}" is revoked: create a new link instead.`);
        return 1;
      }
      const text = o.tokenFile ? await readFile(o.tokenFile, 'utf8') : await io.stdin();
      let token: string;
      try {
        token = tokenFromText(text);
      } catch (err) {
        // tokenFromText words its own refusal and never repeats the input.
        io.err((err as Error).message);
        return 1;
      }
      if (!(await setOutboundToken(ownerId, found.id, token))) {
        io.err('The peer is gone.');
        return 1;
      }
      const after = (await listPeers(ownerId)).find((p) => p.id === found.id) ?? found;
      await audit('peer.accepted', after);
      io.out(`peer_id=${after.id}`);
      io.out(`status=${after.status}`);
      return 0;
    }

    // revoke
    await setPeerEnabled(ownerId, found.id, false);
    await audit('peer.revoked', found);
    io.out(`peer_id=${found.id}`);
    io.out('status=revoked');
    return 0;
  });
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  return run(o, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    stdin: readAllStdin,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Never the caught text of a token error (tokenFromText words its own).
      console.error(`peer-link stopped: ${(err as Error).message}`);
      process.exit(1);
    });
}
