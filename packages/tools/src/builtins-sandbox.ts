/**
 * CLI sandboxes — persistent, isolated terminal environments for the coder
 * agent, managed by the `sandboxd` supervisor sidecar (server/sandboxd) over
 * HTTP. The sibling of `run_terminal`, with the opposite blast radius:
 * run_terminal acts on the SERVER (the brain's own container); sandbox_exec
 * acts inside a disposable Ubuntu container on an isolated network that
 * cannot reach the brain's services. Untrusted work — cloning repos, running
 * their code, `curl | bash` — belongs HERE.
 *
 * The container is disposable; the work is not: each sandbox's /files is a
 * host directory that survives `sandbox_rm` unless explicitly purged. Rows
 * live in the `sandboxes` table (owner-scoped, name-addressable); per-command
 * history is on trace steps like every tool call.
 *
 * Feature presence is a per-box choice: sandboxd runs behind the `sandboxes`
 * compose profile. When it's absent these tools fail with a clear pointer
 * instead of half-working.
 */

import type { BuiltinToolDef } from './types';
import {
  sandbox_create,
  sandbox_exec,
  sandbox_list,
  sandbox_stop,
  sandbox_rm,
  sandbox_autostart,
} from './sandbox/lifecycle';
import { sandbox_export, sandbox_import, sandbox_ls, sandbox_publish } from './sandbox/files';
import { sandbox_mcp_tools, sandbox_mcp_call } from './sandbox/mcp';

export const SANDBOX_TOOLS: BuiltinToolDef[] = [
  sandbox_create,
  sandbox_exec,
  sandbox_list,
  sandbox_stop,
  sandbox_rm,
  sandbox_export,
  sandbox_import,
  sandbox_ls,
  sandbox_autostart,
  sandbox_publish,
  sandbox_mcp_tools,
  sandbox_mcp_call,
];

export const SANDBOX_TOOL_SLUGS = SANDBOX_TOOLS.map((t) => t.slug);
