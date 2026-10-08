/**
 * Peer tools over the peer's MCP endpoint (plan page e5b854dd, Part 2).
 *
 * A peer bound to a login on ITS side (owner, a member or a client, with a
 * write switch) accepts our token on its `/api/mcp`, and runs every call as
 * that login. These tools are our half: list what the peer lets us call,
 * call one, and copy one of our files over. What we may do is decided on
 * the peer's side, by the login and switches the peer's owner set; nothing
 * here widens it. The older federation tools (peer_query, peer_node_get,
 * peer_search_chunks) keep working against the share-only routes.
 *
 * Every result is the peer's content: it is marked untrusted, like any
 * third-party result.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { markPeerContacted, peerCallTarget } from '@mantle/content';
import { readFileById } from '@mantle/files';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { boolOpt, str, strOpt } from './coerce';
import { FILE_ID_PRE } from './builtins-common';

const CALL_TIMEOUT_MS = 120_000;
const RESULT_TEXT_CAP = 80_000;
/** The largest file peer_file_copy sends (the peer's own caps still apply:
 *  64 MB for an owner's file_upload, the space limits for a member). */
const COPY_MAX_BYTES = 48 * 1024 * 1024;

type PeerSession = { client: Client; peerName: string; close: () => Promise<void> };

async function openPeer(ownerId: string, ref: string): Promise<PeerSession | { error: string }> {
  const target = await peerCallTarget(ownerId, ref);
  if ('error' in target) return target;
  const url = new URL(`${target.peer.baseUrl}/api/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
  });
  const client = new Client({ name: 'mantle-peer', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 20_000 });
  } catch (err) {
    await transport.close().catch(() => {});
    const msg = errorMessage(err);
    const hint = /401|unauthor/i.test(msg)
      ? ' The peer refused our token on its MCP endpoint: its owner must bind this peer to a login (Acts as) and turn remote MCP on.'
      : /404/.test(msg)
        ? ' The peer has remote MCP turned off (Settings, MCP on that brain).'
        : '';
    return { error: `Could not reach ${target.peer.displayName} over MCP: ${msg}.${hint}` };
  }
  return {
    client,
    peerName: target.peer.displayName,
    close: async () => {
      await client.close().catch(() => {});
      await markPeerContacted(ownerId, target.peer.id).catch(() => {});
    },
  };
}

async function withPeer(
  ownerId: string,
  ref: string,
  fn: (s: PeerSession) => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  if (!ref.trim()) return { ok: false, error: 'peer is required: a name or id from `peer_list`.' };
  const s = await openPeer(ownerId, ref);
  if ('error' in s) return { ok: false, error: s.error };
  try {
    return await fn(s);
  } catch (err) {
    return { ok: false, error: `${s.peerName}: ${errorMessage(err).slice(0, 2000)}` };
  } finally {
    await s.close();
  }
}

/** A remote tool result as one output: its text joined, JSON when it parses. */
function resultOutput(raw: unknown): ToolHandlerResult {
  const res = (raw ?? {}) as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(res.content) ? res.content : [];
  let text = parts
    .map((p) =>
      p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
    )
    .join('\n');
  const truncated = text.length > RESULT_TEXT_CAP;
  if (truncated) text = text.slice(0, RESULT_TEXT_CAP);
  if (res.isError) return { ok: false, error: text.slice(0, 2000) || 'the peer tool failed' };
  let output: unknown = truncated ? `${text}\n[truncated at ${RESULT_TEXT_CAP} chars]` : text;
  if (!truncated) {
    try {
      output = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { ok: true, output, untrusted: true };
}

function firstSentence(s: string | undefined): string {
  const t = (s ?? '').trim();
  const cut = t.search(/[.!?](\s|$)/);
  return (cut > 0 ? t.slice(0, cut + 1) : t).slice(0, 200);
}

const peer_tools: BuiltinToolDef = {
  slug: 'peer_tools',
  readOnly: true,
  name: 'List the tools a peer lets us call',
  description:
    "List the tools a federated peer lets this brain call on its MCP endpoint, as the login the peer's owner bound us to (the owner, a member or a client, read-only unless they turned write on). Returns names and one-line descriptions; pass `tool` to get one tool's full input schema before `peer_call`. For data a peer shared the older way use `peer_query`.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The peer's name or id (see `peer_list`)." },
      q: {
        type: 'string',
        maxLength: 100,
        description: "Only tools whose name has this, e.g. 'file'.",
      },
      tool: {
        type: 'string',
        maxLength: 100,
        description: 'One tool name: return its input schema.',
      },
    },
    required: ['peer'],
  },
  handler: (input, ctx) =>
    withPeer(ctx.ownerId, str(input.peer), async ({ client, peerName }) => {
      const res = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      const tool = strOpt(input.tool);
      if (tool) {
        const t = res.tools.find((x) => x.name === tool);
        if (!t) {
          return {
            ok: false,
            error: `${peerName} does not offer '${tool}' to us; list its tools without \`tool\`.`,
          };
        }
        return {
          ok: true,
          output: {
            peer: peerName,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          },
          untrusted: true,
        };
      }
      const q = strOpt(input.q)?.toLowerCase();
      const tools = res.tools
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .map((t) => ({ name: t.name, description: firstSentence(t.description) }));
      ctx.step?.setMeta({ peer: peerName, count: tools.length });
      return { ok: true, output: { peer: peerName, tools, count: tools.length }, untrusted: true };
    }),
};

const peer_call: BuiltinToolDef = {
  slug: 'peer_call',
  name: 'Call a tool on a peer',
  description:
    "Call one tool on a federated peer's MCP endpoint, as the login the peer's owner bound us to. It can WRITE on the peer when the peer allows it (its write switch). Get the tool names and schemas with `peer_tools` first. To copy one of our files to the peer use `peer_file_copy`.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The peer's name or id (see `peer_list`)." },
      tool: {
        type: 'string',
        maxLength: 100,
        description: "The peer's tool name, e.g. 'note_create'.",
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: "The tool's arguments, as its schema in `peer_tools` says.",
      },
    },
    required: ['peer', 'tool'],
  },
  handler: (input, ctx) =>
    withPeer(ctx.ownerId, str(input.peer), async ({ client, peerName }) => {
      const tool = str(input.tool).trim();
      if (!tool) return { ok: false, error: 'tool is required: a name from `peer_tools`.' };
      const args =
        input.args && typeof input.args === 'object' && !Array.isArray(input.args)
          ? (input.args as Record<string, unknown>)
          : {};
      const res = await client.callTool(
        { name: tool, arguments: args },
        {
          timeout: CALL_TIMEOUT_MS,
        },
      );
      ctx.step?.setMeta({ peer: peerName, tool });
      return resultOutput(res);
    }),
};

const peer_file_copy: BuiltinToolDef = {
  slug: 'peer_file_copy',
  name: 'Copy one of our files to a peer',
  preconditions: FILE_ID_PRE,
  description:
    "Copy a file from this brain to a federated peer. If the peer binds us to its owner (with write on) it lands in `folder_path` there (default 'files'), `overwrite` replacing a same-named file; if it binds us to a member or client it lands as a draft in that login's own space. The peer refuses when write is off. Use `peer_tools` to see what the peer allows.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The peer's name or id (see `peer_list`)." },
      file_id: { type: 'string', description: 'Our file id, from `file_list` or `search_nodes`.' },
      folder_path: {
        type: 'string',
        maxLength: 500,
        description: "The folder on the peer (ltree path), e.g. 'files.sermons'.",
      },
      filename: { type: 'string', maxLength: 200, description: 'A new name on the peer.' },
      overwrite: { type: 'boolean', description: 'Replace a same-named file on the peer.' },
    },
    required: ['peer', 'file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    const file = await readFileById({ ownerId: ctx.ownerId, fileId }).catch(() => null);
    if (!file) {
      return {
        ok: false,
        error: `no file '${fileId}' here; find it with \`file_list\` or \`search_nodes\`.`,
      };
    }
    if (file.bytes.byteLength > COPY_MAX_BYTES) {
      return { ok: false, error: `the file is too large to copy (over ${COPY_MAX_BYTES} bytes).` };
    }
    const filename = strOpt(input.filename)?.trim() || file.row.filename;
    const b64 = file.bytes.toString('base64');
    return withPeer(ctx.ownerId, str(input.peer), async ({ client, peerName }) => {
      const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      const names = new Set(tools.map((t) => t.name));
      let res;
      if (names.has('file_upload')) {
        res = await client.callTool(
          {
            name: 'file_upload',
            arguments: {
              parent_path: strOpt(input.folder_path)?.trim() || 'files',
              filename,
              content_base64: b64,
              ...(boolOpt(input.overwrite) ? { overwrite: true } : {}),
            },
          },
          { timeout: CALL_TIMEOUT_MS },
        );
      } else if (names.has('my_file_upload')) {
        res = await client.callTool(
          { name: 'my_file_upload', arguments: { filename, content_base64: b64 } },
          { timeout: CALL_TIMEOUT_MS },
        );
      } else {
        return {
          ok: false,
          error: `${peerName} does not let us write files (its write switch is off, or it binds us to no login).`,
        };
      }
      ctx.step?.setMeta({ peer: peerName, bytes: file.bytes.byteLength });
      return resultOutput(res);
    });
  },
};

/** The peer tools that ride the peer's MCP endpoint. */
export const PEER_MCP_TOOLS: readonly BuiltinToolDef[] = [peer_tools, peer_call, peer_file_copy];
