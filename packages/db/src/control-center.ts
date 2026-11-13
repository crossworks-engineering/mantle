/**
 * The Control Center's own rows (migration 0364, docs/control-center.md):
 * the linked boxes, the bans, per ban and box what the last run matched,
 * and the control service's row. The one module both the Fleet routes and
 * tools (server/web, packages/tools) and the control service
 * (server/web/workers/control.ts) use.
 *
 * The match (plan section 3.4) runs here, at the CC, never on a box: a
 * login matches a ban when its email, lowercased, is one of the ban's, or
 * when one of its company sign-in links has the ban's issuer and object id.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { isUuid } from '@mantle/std';
import { db } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import {
  controlBans,
  controlBoxes,
  controlResults,
  controlService,
  CONTROL_MAX_WRITE_CHANGES,
  CONTROL_ENDPOINT,
  CONTROL_MODEL_ID,
  type ControlFacts,
  type ControlKeyResult,
  type ControlLogin,
  CONTROL_MAX_WAITING_WRITES,
  CONTROL_LABEL,
  CONTROL_PROVIDER,
  CONTROL_SLUG,
  type ControlWriteAnswer,
  type ControlWriteChange,
  type ControlToolCall,
  type ControlSsoStatus,
  type ControlSsoView,
} from './schema/control';

export type ControlBan = typeof controlBans.$inferSelect;
export type ControlBox = typeof controlBoxes.$inferSelect;
export type BanKeys = Pick<ControlBan, 'emails' | 'issuer' | 'oid'>;

/** How often the control service runs every box (plan section 3.1). */
export const CONTROL_RUN_EVERY_MS = 5 * 60_000;
/** The most emails one ban names. */
export const CONTROL_MAX_BAN_EMAILS = 50;

/** Every write of the four Control Center tables, at the full-route spot
 *  control-center: the narrow login only reads them (access-matrix.ts). */
function controlWrite<T>(fn: () => PromiseLike<T>): Promise<T> {
  return onFullSystemRoute('control-center', fn);
}

// --- input -------------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A box URL as a CC Admin types it: https, a host, no path, query or
 *  credentials. The origin is what is stored and signed. */
export function checkBoxUrl(input: string): Checked<string> {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Give the box URL, for example https://box.example.com.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The box URL must start with https://.' };
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { ok: false, error: 'Give the box origin only: https and the host, no path.' };
  }
  if (u.origin.length > 300) return { ok: false, error: 'The box URL is too long.' };
  return { ok: true, value: u.origin };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

export type BanInput = {
  kind?: 'disable' | 'archive';
  emails?: string[];
  issuer?: string | null;
  oid?: string | null;
  reason?: string | null;
};

/** A ban's keys, checked: lowercase emails (at least one key), and the
 *  company sign-in issuer and object id both or neither. */
export function checkBan(input: BanInput): Checked<Required<BanInput> & BanKeys> {
  const emails = [...new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()))].filter(
    (e) => e.length > 0,
  );
  if (emails.length > CONTROL_MAX_BAN_EMAILS) {
    return { ok: false, error: `A ban names at most ${CONTROL_MAX_BAN_EMAILS} emails.` };
  }
  const bad = emails.find((e) => !EMAIL.test(e) || e.length > 254);
  if (bad !== undefined) return { ok: false, error: 'Each email must be a valid address.' };
  const issuer = input.issuer?.trim() || null;
  const oid = input.oid?.trim().toLowerCase() || null;
  if ((issuer === null) !== (oid === null)) {
    return { ok: false, error: 'Give the sign-in issuer and object id together, or neither.' };
  }
  if (issuer !== null && (!/^https:\/\/\S+$/.test(issuer) || issuer.length > 300)) {
    return { ok: false, error: 'The sign-in issuer must be an https URL.' };
  }
  if (oid !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(oid)) {
    return { ok: false, error: 'The object id has characters it cannot have.' };
  }
  if (emails.length === 0 && oid === null) {
    return { ok: false, error: 'A ban needs an email, or a sign-in issuer and object id.' };
  }
  const reason = input.reason?.trim().slice(0, 500) || null;
  return { ok: true, value: { kind: input.kind ?? 'disable', emails, issuer, oid, reason } };
}

// --- the match ---------------------------------------------------------------

export function loginMatches(login: ControlLogin, ban: BanKeys): boolean {
  if (ban.emails.includes(login.email.toLowerCase())) return true;
  if (ban.issuer === null || ban.oid === null) return false;
  const oid = ban.oid.toLowerCase();
  return login.links.some((l) => l.issuer === ban.issuer && l.oid.toLowerCase() === oid);
}

export type BoxPlan = {
  disable: string[];
  archive: string[];
  enable: string[];
  /** Matched by an active ban and the box owner: never disabled. */
  owners: string[];
  /** Per active ban: how many logins it matched, and the owner ids. */
  perBan: Map<string, { matched: number; ownerIds: string[] }>;
};

/**
 * What one run asks of one box (plan sections 3.1, 3.5, 3.6), from its
 * login list and the bans:
 *  - archive: matched by an active archive ban, not yet archived;
 *  - disable: matched by an active disable ban, still enabled;
 *  - enable: disabled by the CC (its marker still holds), matched by a
 *    lifted disable ban, and by no active ban. The box checks the marker
 *    again; a lifted (retired) archive ban never enables.
 * The box owner is never in any list: it is reported instead.
 */
export function planBox(logins: readonly ControlLogin[], bans: readonly ControlBan[]): BoxPlan {
  const active = bans.filter((b) => b.liftedAt === null);
  const lifted = bans.filter((b) => b.liftedAt !== null && b.kind === 'disable');
  const plan: BoxPlan = { disable: [], archive: [], enable: [], owners: [], perBan: new Map() };
  for (const b of active) plan.perBan.set(b.id, { matched: 0, ownerIds: [] });
  for (const l of logins) {
    const hits = active.filter((b) => loginMatches(l, b));
    for (const b of hits) {
      const r = plan.perBan.get(b.id)!;
      r.matched++;
      if (l.owner) r.ownerIds.push(l.id);
    }
    if (hits.length > 0) {
      if (l.owner) plan.owners.push(l.id);
      else if (hits.some((b) => b.kind === 'archive')) {
        if (!l.archived) plan.archive.push(l.id);
      } else if (!l.disabled) plan.disable.push(l.id);
      continue;
    }
    if (l.marked && !l.archived && !l.owner && lifted.some((b) => loginMatches(l, b))) {
      plan.enable.push(l.id);
    }
  }
  return plan;
}

// --- boxes -------------------------------------------------------------------

/** A box as the Fleet screen and tools see it: never the sealed key of a
 *  key job, only which service waits, for whom, since when. */
export type BoxView = Omit<ControlBoxRow, 'logins' | 'keyJob'> & {
  loginCount: number | null;
  keyPending: { service: string; by: string; at: string } | null;
  /** The box's time of its last good facts (the matrix holds them). */
  factsAt: string | null;
};

/** A box row without its facts: what the Fleet screen and the control
 *  service read (the facts are the matrix's; only their time is shown). */
export type ControlBoxRow = Omit<ControlBox, 'facts' | 'toolJob' | 'ssoView'>;
const BOX_COLUMNS = (() => {
  // The admin channel's calls and the sign-in view are read by their own
  // functions (below).
  const { facts, toolJob, ssoView, ...rest } = getTableColumns(controlBoxes);
  void facts;
  void toolJob;
  void ssoView;
  return rest;
})();

function boxView(row: ControlBoxRow, factsAt: string | null): BoxView {
  const { logins, keyJob, ...rest } = row;
  return {
    ...rest,
    loginCount: logins ? logins.length : null,
    factsAt,
    keyPending: keyJob ? { service: keyJob.service, by: keyJob.by, at: keyJob.at } : null,
  };
}

export async function listControlBoxes(): Promise<BoxView[]> {
  const rows = await db
    .select({ ...BOX_COLUMNS, factsAt: sql<string | null>`${controlBoxes.facts}->>'at'` })
    .from(controlBoxes)
    .orderBy(asc(controlBoxes.url));
  return rows.map(({ factsAt, ...row }) => boxView(row, factsAt));
}

/** Adds a box (its first run is asked for at once). Null when the URL is
 *  already linked. */
export async function addControlBox(
  url: string,
  label: string | null,
  addedBy: string,
): Promise<BoxView | null> {
  const rows = await controlWrite(() =>
    db
      .insert(controlBoxes)
      .values({
        url,
        label: label?.trim().slice(0, 100) || null,
        addedBy,
        runRequestedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: controlBoxes.url })
      .returning(BOX_COLUMNS),
  );
  return rows[0] ? boxView(rows[0], null) : null;
}

/** Stops every call to the box. The box keeps what was done there. */
export async function removeControlBox(id: string): Promise<boolean> {
  const rows = await controlWrite(() =>
    db.delete(controlBoxes).where(eq(controlBoxes.id, id)).returning({ id: controlBoxes.id }),
  );
  return rows.length > 0;
}

// --- the fleet matrix (phase 3) ----------------------------------------------

/** One box's line in the fleet matrix: its last good facts (numbers,
 *  settings and model ids), and why the last read failed, if it did. */
export type MatrixRow = Pick<
  ControlBox,
  'id' | 'url' | 'label' | 'lastOkAt' | 'lastReason' | 'facts' | 'factsReason'
>;

/** The fleet matrix: every box, or the one `boxId` names. */
export async function listControlMatrix(boxId?: string): Promise<MatrixRow[]> {
  return db
    .select({
      id: controlBoxes.id,
      url: controlBoxes.url,
      label: controlBoxes.label,
      lastOkAt: controlBoxes.lastOkAt,
      lastReason: controlBoxes.lastReason,
      facts: controlBoxes.facts,
      factsReason: controlBoxes.factsReason,
    })
    .from(controlBoxes)
    .where(boxId ? eq(controlBoxes.id, boxId) : undefined)
    .orderBy(asc(controlBoxes.url));
}

/** Records a facts read (the control service, each run): the facts and no
 *  reason, or only the reason (the last good facts stay). */
export async function saveControlFacts(
  boxId: string,
  read: { facts: ControlFacts } | { reason: string },
): Promise<void> {
  await controlWrite(() =>
    db
      .update(controlBoxes)
      .set(
        'facts' in read ? { facts: read.facts, factsReason: null } : { factsReason: read.reason },
      )
      .where(eq(controlBoxes.id, boxId)),
  );
}

// --- provider keys (phase 2) --------------------------------------------------

/** The AAD a key job's value is sealed with: the box it is for. */
export function controlKeyAad(boxId: string): string {
  return `control-key:${boxId}`;
}

/** A service name as a box's key list spells one. The box checks its own
 *  list; this only keeps junk out of the row. */
export const CONTROL_KEY_SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** How long a key job may wait: older, the control service deletes it
 *  unsent (owner direction: the CC holds a sealed key for an hour at most). */
export const CONTROL_KEY_JOB_TTL_MS = 60 * 60_000;

/** The longest key value (the box's cap). */
export const CONTROL_MAX_KEY = 8192;

export function checkKeyInput(input: {
  service?: string;
  value?: string;
}): Checked<{ service: string; value: string }> {
  const service = (input.service ?? '').trim().toLowerCase();
  const value = (input.value ?? '').trim();
  if (!CONTROL_KEY_SERVICE.test(service)) {
    return { ok: false, error: 'service must be a provider name, e.g. openrouter.' };
  }
  if (value === '' || value.length > CONTROL_MAX_KEY) {
    return { ok: false, error: `value must be the key, 1 to ${CONTROL_MAX_KEY} characters.` };
  }
  return { ok: true, value: { service, value } };
}

/**
 * Queues a provider key for each box (`boxIds`, or every linked box) and
 * asks for their run now. `seal(boxId)` seals the value for that box (the
 * caller holds the master key's code; this package does not). A newer job
 * replaces one still waiting. Returns the ids of the boxes queued.
 */
export async function queueControlKey(
  service: string,
  seal: (boxId: string) => string,
  by: string,
  boxIds?: readonly string[],
): Promise<string[]> {
  return controlWrite(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: controlBoxes.id })
        .from(controlBoxes)
        .where(boxIds ? inArray(controlBoxes.id, [...boxIds]) : sql`true`);
      const at = new Date().toISOString();
      for (const { id } of rows) {
        await tx
          .update(controlBoxes)
          .set({ keyJob: { service, sealed: seal(id), by, at }, runRequestedAt: sql`now()` })
          .where(eq(controlBoxes.id, id));
      }
      return rows.map((r) => r.id);
    }),
  );
}

/** Records the box's answer to the key job sent at `at`, and clears that
 *  job (a newer one stays for the next run). */
export async function saveControlKeyResult(
  boxId: string,
  at: string,
  result: ControlKeyResult,
): Promise<void> {
  await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({ keyResult: result, keyJob: null })
      .where(and(eq(controlBoxes.id, boxId), sql`${controlBoxes.keyJob}->>'at' = ${at}`)),
  );
}

/** Deletes, unsent, every key job older than CONTROL_KEY_JOB_TTL_MS (the
 *  control service, each tick), and records `expired` as that box's answer. */
export async function expireControlKeyJobs(): Promise<number> {
  const rows = await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({
        keyResult: sql`jsonb_build_object('service', ${controlBoxes.keyJob}->>'service', 'ok', false, 'reason', 'expired', 'by', ${controlBoxes.keyJob}->>'by', 'at', ${new Date().toISOString()}::text)`,
        keyJob: null,
      })
      .where(
        sql`${controlBoxes.keyJob} is not null and (${controlBoxes.keyJob}->>'at')::timestamptz < now() - make_interval(secs => ${CONTROL_KEY_JOB_TTL_MS / 1000})`,
      )
      .returning({ id: controlBoxes.id }),
  );
  return rows.length;
}

// --- fleet writes (phase 4) ---------------------------------------------------

/** How long a change may wait: older, it is dropped unsent (as a key job),
 *  so a box that comes back a day later is not changed by surprise. */
export const CONTROL_WRITE_JOB_TTL_MS = 60 * 60_000;

const SLUG = CONTROL_SLUG;
const LABEL = CONTROL_LABEL;
const PROVIDER = CONTROL_PROVIDER;

/** The changes of a model request, checked: 1 to 20, each a slug of the
 *  form a shipped agent has and a model id. The box checks the slug is one
 *  it ships; this only keeps junk out of the row. */
export function checkModelChanges(
  input: readonly unknown[] | undefined,
): Checked<Extract<ControlWriteChange, { kind: 'agentModel' }>[]> {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const list = (input ?? []).map((raw) => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      slug: (text(c.slug) ?? '').toLowerCase(),
      model: text(c.model) ?? '',
      provider: text(c.provider)?.toLowerCase(),
      endpoint: text(c.endpoint)?.toLowerCase(),
    };
  });
  if (list.length === 0 || list.length > CONTROL_MAX_WRITE_CHANGES) {
    return { ok: false, error: `Give 1 to ${CONTROL_MAX_WRITE_CHANGES} changes.` };
  }
  // A route field that is there but not text is an error, never "no route".
  for (const raw of input ?? []) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    for (const f of ['provider', 'endpoint'] as const) {
      if (c[f] !== undefined && typeof c[f] !== 'string') {
        return { ok: false, error: `${f} is text, e.g. openrouter, or left out.` };
      }
    }
  }
  for (const c of list) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.slug)) {
      return { ok: false, error: 'Each slug must be an agent the system ships, e.g. coder.' };
    }
    if (!CONTROL_MODEL_ID.test(c.model)) {
      return { ok: false, error: 'Each model must be a model id, e.g. vendor/model-name.' };
    }
    // The source route, both or neither: a box on another route refuses.
    if ((c.provider === undefined) !== (c.endpoint === undefined)) {
      return { ok: false, error: 'Give provider and endpoint together, or neither.' };
    }
    if (c.provider !== undefined && !PROVIDER.test(c.provider)) {
      return { ok: false, error: 'A provider is an id, e.g. openrouter.' };
    }
    if (c.endpoint !== undefined && !CONTROL_ENDPOINT.test(c.endpoint)) {
      return { ok: false, error: "An endpoint is the matrix's print of it (12 hex), or empty." };
    }
  }
  if (new Set(list.map((c) => c.slug)).size !== list.length) {
    return { ok: false, error: 'Name each slug once.' };
  }
  return {
    ok: true,
    value: list.map((c) => ({
      kind: 'agentModel' as const,
      slug: c.slug,
      model: c.model,
      ...(c.provider !== undefined ? { provider: c.provider, endpoint: c.endpoint! } : {}),
    })),
  };
}

/** The changes of a settings request (POST /api/fleet/settings), checked:
 *  1 to 20, each a pool entry, the update notice, a worker group or a
 *  worker's model, held to the shapes the box takes. The box checks the
 *  rest (a pool it has, its model policy and the pool's fit, workers it
 *  has, a shipped worker kind). */
export function checkSettingChanges(
  input: readonly unknown[] | undefined,
): Checked<ControlWriteChange[]> {
  const list = input ?? [];
  if (list.length === 0 || list.length > CONTROL_MAX_WRITE_CHANGES) {
    return { ok: false, error: `Give 1 to ${CONTROL_MAX_WRITE_CHANGES} changes.` };
  }
  const out: ControlWriteChange[] = [];
  for (const raw of list) {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (c.kind === 'updateNotice') {
      if (typeof c.on !== 'boolean')
        return { ok: false, error: 'updateNotice needs on: true or false.' };
      out.push({ kind: 'updateNotice', on: c.on });
    } else if (c.kind === 'poolEntry') {
      const pool = text(c.pool).toLowerCase();
      const name = text(c.name);
      const vendor = text(c.vendor);
      const routes = (Array.isArray(c.routes) ? c.routes : []).map((r) => {
        const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        return { provider: text(rr.provider).toLowerCase(), model: text(rr.model) };
      });
      if (!SLUG.test(pool)) return { ok: false, error: 'poolEntry needs a pool id, e.g. agents.' };
      if (!LABEL.test(name))
        return { ok: false, error: 'poolEntry needs a name, e.g. Claude Sonnet 5.' };
      if (vendor && (vendor.length > 80 || !LABEL.test(vendor)))
        return { ok: false, error: 'A vendor is a short name, e.g. Anthropic.' };
      if (routes.length < 1 || routes.length > 8) {
        return { ok: false, error: 'poolEntry needs 1 to 8 routes { provider, model }.' };
      }
      if (routes.some((r) => !PROVIDER.test(r.provider) || !CONTROL_MODEL_ID.test(r.model))) {
        return {
          ok: false,
          error: 'Each route is { provider, model }, e.g. openrouter and vendor/model-name.',
        };
      }
      out.push({ kind: 'poolEntry', pool, name, ...(vendor ? { vendor } : {}), routes });
    } else if (c.kind === 'workerGroup') {
      const slug = text(c.slug).toLowerCase();
      const name = text(c.name);
      const members = (Array.isArray(c.members) ? c.members : []).map((m) => text(m).toLowerCase());
      if (!SLUG.test(slug))
        return { ok: false, error: 'workerGroup needs a slug, e.g. review-panel.' };
      if (name && !LABEL.test(name)) return { ok: false, error: 'A group name is a short name.' };
      if (members.length < 1 || members.length > 10 || members.some((m) => !SLUG.test(m))) {
        return { ok: false, error: 'workerGroup needs 1 to 10 member worker slugs.' };
      }
      if (new Set(members).size !== members.length)
        return { ok: false, error: 'Name each member once.' };
      if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
        return { ok: false, error: 'enabled is true or false.' };
      }
      out.push({
        kind: 'workerGroup',
        slug,
        ...(name ? { name } : {}),
        members,
        ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}),
      });
    } else if (c.kind === 'workerModel') {
      const worker = text(c.worker).toLowerCase();
      const provider = text(c.provider).toLowerCase();
      const endpoint = text(c.endpoint).toLowerCase();
      const model = text(c.model);
      if (!SLUG.test(worker)) {
        return { ok: false, error: 'workerModel needs a worker kind, e.g. summarizer.' };
      }
      if (!PROVIDER.test(provider)) {
        return {
          ok: false,
          error: "workerModel needs the worker's provider, e.g. openrouter (from the matrix).",
        };
      }
      if (!CONTROL_MODEL_ID.test(model)) {
        return { ok: false, error: 'workerModel needs a model id, e.g. vendor/model-name.' };
      }
      if (typeof c.endpoint !== 'string' || !CONTROL_ENDPOINT.test(endpoint)) {
        return {
          ok: false,
          error: "workerModel needs the worker's endpoint: the matrix's print (12 hex), or empty.",
        };
      }
      out.push({ kind: 'workerModel', worker, provider, endpoint, model });
    } else {
      return {
        ok: false,
        error: 'Each change has kind poolEntry, updateNotice, workerGroup or workerModel.',
      };
    }
  }
  const keys = out.map(writeKey);
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'Name each item once.' };
  return { ok: true, value: out };
}

/** What a change sets: two changes with one key set the same thing. */
function writeKey(c: ControlWriteChange): string {
  switch (c.kind) {
    case 'agentModel':
      return `agent:${c.slug}`;
    case 'poolEntry':
      return `pool:${c.pool}:${c.name.toLowerCase()}`;
    case 'updateNotice':
      return 'notice';
    case 'workerGroup':
      return `group:${c.slug}`;
    case 'workerModel':
      return `worker:${c.worker}`;
  }
}

/** The last CONTROL_MAX_WAITING_WRITES elements of a jsonb array, in order. */
const lastKept = (arr: SQL) =>
  sql`(select coalesce(jsonb_agg(e order by i), '[]'::jsonb)
    from jsonb_array_elements(${arr}) with ordinality t(e, i)
    where i > jsonb_array_length(${arr}) - ${CONTROL_MAX_WAITING_WRITES})`;

/** Queues fleet writes for each box (`boxIds`, or every linked box) and
 *  asks for their run now. They join the end of what waits; a box that
 *  would then hold more than CONTROL_MAX_WAITING_WRITES is not queued.
 *  Returns the ids of the boxes queued. */
export async function queueControlWrites(
  changes: ControlWriteChange[],
  by: string,
  boxIds?: readonly string[],
): Promise<string[]> {
  const at = new Date().toISOString();
  const stamped = JSON.stringify(changes.map((c) => ({ ...c, by, at })));
  const waiting = sql`coalesce(${controlBoxes.writeJob}->'changes', '[]'::jsonb)`;
  const rows = await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({
        writeJob: sql`jsonb_build_object('changes', ${waiting} || ${stamped}::jsonb)`,
        runRequestedAt: sql`now()`,
      })
      .where(
        and(
          boxIds ? inArray(controlBoxes.id, [...boxIds]) : sql`true`,
          sql`jsonb_array_length(${waiting}) + ${changes.length} <= ${CONTROL_MAX_WAITING_WRITES}`,
        ),
      )
      .returning({ id: controlBoxes.id }),
  );
  return rows.map((r) => r.id);
}

/** Records the box's answers to the first `answers.length` changes of its
 *  job (sent from the job whose first change was stamped `firstAt`), and
 *  takes them off the front: changes queued since stay for the next run.
 *  Only the control service takes changes off, one run at a time. */
export async function saveControlWriteResult(
  boxId: string,
  firstAt: string,
  answers: ControlWriteAnswer[],
): Promise<void> {
  const n = answers.length;
  const kept = sql`coalesce(${controlBoxes.writeResult}->'results', '[]'::jsonb) || ${JSON.stringify(answers)}::jsonb`;
  await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({
        writeResult: sql`jsonb_build_object('results', ${lastKept(kept)})`,
        writeJob: sql`(select case when count(*) = 0 then null
            else jsonb_build_object('changes', jsonb_agg(e order by i)) end
          from jsonb_array_elements(${controlBoxes.writeJob}->'changes') with ordinality t(e, i)
          where i > ${n})`,
      })
      .where(
        and(
          eq(controlBoxes.id, boxId),
          sql`${controlBoxes.writeJob}->'changes'->0->>'at' = ${firstAt}`,
        ),
      ),
  );
}

/** Drops, unsent, every change older than CONTROL_WRITE_JOB_TTL_MS (the
 *  control service, each tick), and records each as `expired`. */
export async function expireControlWriteJobs(): Promise<number> {
  const old = sql`(e->>'at')::timestamptz < now() - make_interval(secs => ${CONTROL_WRITE_JOB_TTL_MS / 1000})`;
  const expired = sql`(select coalesce(jsonb_agg(e || jsonb_build_object('ok', false, 'was', null,
      'reason', 'expired', 'done', ${new Date().toISOString()}::text) order by i), '[]'::jsonb)
    from jsonb_array_elements(${controlBoxes.writeJob}->'changes') with ordinality t(e, i) where ${old})`;
  const kept = sql`coalesce(${controlBoxes.writeResult}->'results', '[]'::jsonb) || ${expired}`;
  const rows = await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({
        writeResult: sql`jsonb_build_object('results', ${lastKept(kept)})`,
        writeJob: sql`(select case when count(*) = 0 then null
            else jsonb_build_object('changes', jsonb_agg(e order by i)) end
          from jsonb_array_elements(${controlBoxes.writeJob}->'changes') with ordinality t(e, i)
          where not ${old})`,
      })
      .where(
        sql`${controlBoxes.writeJob} is not null and exists (select 1
          from jsonb_array_elements(${controlBoxes.writeJob}->'changes') e where ${old})`,
      )
      .returning({ id: controlBoxes.id }),
  );
  return rows.length;
}

/** Asks the control service for a run now, of one box or of all. */
export async function requestControlRun(boxId?: string): Promise<void> {
  await controlWrite(() =>
    db
      .update(controlBoxes)
      .set({ runRequestedAt: sql`now()` })
      .where(boxId ? eq(controlBoxes.id, boxId) : sql`true`),
  );
}

// --- bans --------------------------------------------------------------------

export type BanPreview = {
  boxes: {
    boxId: string;
    url: string;
    label: string | null;
    matched: number | null;
    owners: number;
  }[];
  /** Boxes with no login list yet (never run, or never answered). */
  unknown: number;
};

/** What a new ban would match, from each box's last login list. A
 *  preview, not a check: the run itself reads the lists afresh. */
export async function previewControlBan(keys: BanKeys): Promise<BanPreview> {
  const rows = await db.select().from(controlBoxes).orderBy(asc(controlBoxes.url));
  const out: BanPreview = { boxes: [], unknown: 0 };
  for (const r of rows) {
    if (!r.logins) {
      out.unknown++;
      out.boxes.push({ boxId: r.id, url: r.url, label: r.label, matched: null, owners: 0 });
      continue;
    }
    const hits = r.logins.filter((l) => loginMatches(l, keys));
    out.boxes.push({
      boxId: r.id,
      url: r.url,
      label: r.label,
      matched: hits.length,
      owners: hits.filter((l) => l.owner).length,
    });
  }
  return out;
}

export async function makeControlBan(
  ban: { kind: 'disable' | 'archive'; reason: string | null } & BanKeys,
  madeBy: string,
): Promise<ControlBan> {
  const [row] = await controlWrite(() =>
    db
      .insert(controlBans)
      .values({ ...ban, madeBy })
      .returning(),
  );
  await requestControlRun();
  return row!;
}

/**
 * The Entra trigger (plan section 4.1): makes sure an active ban names
 * `email`. Nothing is made when an active ban already holds that email
 * ('held'), else one disable ban with these keys ('made'), and a run of
 * every box is asked for. State, not the edge: the same SCIM disable sent
 * again after a failed write makes the ban then. The read and the insert
 * take no lock: two disables at once can make two bans with the same keys.
 * Harmless (the match is the same); a CC Admin lifts both. Accepted.
 */
export async function ensureControlBan(
  ban: { reason: string | null } & BanKeys,
  madeBy: string,
): Promise<'made' | 'held'> {
  const email = ban.emails[0];
  if (email !== undefined) {
    const [held] = await db
      .select({ id: controlBans.id })
      .from(controlBans)
      .where(
        and(isNull(controlBans.liftedAt), sql`${controlBans.emails} @> array[${email}]::text[]`),
      )
      .limit(1);
    if (held) return 'held';
  }
  await makeControlBan({ kind: 'disable', ...ban }, madeBy);
  return 'made';
}

export type BanView = ControlBan & {
  boxesMatched: number;
  loginsMatched: number;
  ownerIds: string[];
};

export async function listControlBans(opts: { lifted?: boolean } = {}): Promise<BanView[]> {
  const bans = await db
    .select()
    .from(controlBans)
    .where(opts.lifted ? undefined : isNull(controlBans.liftedAt))
    .orderBy(desc(controlBans.madeAt))
    .limit(500);
  if (bans.length === 0) return [];
  const results = await db
    .select()
    .from(controlResults)
    .where(
      inArray(
        controlResults.banId,
        bans.map((b) => b.id),
      ),
    );
  return bans.map((b) => {
    const mine = results.filter((r) => r.banId === b.id);
    return {
      ...b,
      boxesMatched: mine.filter((r) => r.matched > 0).length,
      loginsMatched: mine.reduce((n, r) => n + r.matched, 0),
      ownerIds: mine.flatMap((r) => r.ownerIds),
    };
  });
}

/** Lifts a ban (an archive ban is retired: its runs stop, nothing is
 *  enabled). Null when there is no such ban still active. */
export async function liftControlBan(id: string, liftedBy: string): Promise<ControlBan | null> {
  const [row] = await controlWrite(() =>
    db
      .update(controlBans)
      .set({ liftedAt: sql`now()`, liftedBy })
      .where(and(eq(controlBans.id, id), isNull(controlBans.liftedAt)))
      .returning(),
  );
  if (!row) return null;
  await requestControlRun();
  return row;
}

/** Per box: what each active ban matched there (the Fleet results). */
export async function listControlResults() {
  return db
    .select({
      banId: controlResults.banId,
      boxId: controlResults.boxId,
      matched: controlResults.matched,
      ownerIds: controlResults.ownerIds,
      updatedAt: controlResults.updatedAt,
    })
    .from(controlResults)
    .innerJoin(controlBans, eq(controlBans.id, controlResults.banId))
    .where(isNull(controlBans.liftedAt));
}

// --- the control service's row -----------------------------------------------

/** A short fingerprint of a key line: the first 16 hex characters of its
 *  sha256. The service logs it at boot; the Fleet screen shows it. */
export function keyFingerprint(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

export async function controlServiceState(): Promise<{
  publicKey: string;
  fingerprint: string;
  lastTickAt: Date | null;
} | null> {
  const [row] = await db.select().from(controlService).limit(1);
  if (!row) return null;
  return {
    publicKey: row.publicKey,
    fingerprint: keyFingerprint(row.publicKey),
    lastTickAt: row.lastTickAt,
  };
}

// --- the control service's own reads and writes ------------------------------

/** The service's key line and its tick, in one upsert: written at its
 *  start and every tick, so a row changed by anything else is put right
 *  within seconds. */
export async function noteControlTick(publicKey: string): Promise<void> {
  await controlWrite(() =>
    db
      .insert(controlService)
      .values({ id: true, publicKey, lastTickAt: sql`now()` })
      .onConflictDoUpdate({
        target: controlService.id,
        set: { publicKey, lastTickAt: sql`now()`, updatedAt: sql`now()` },
      }),
  );
}

/** The boxes due a run: asked for, or not run for CONTROL_RUN_EVERY_MS.
 *  The ask is taken (cleared) as they are read. */
export async function takeDueControlBoxes(): Promise<ControlBoxRow[]> {
  const cutoff = new Date(Date.now() - CONTROL_RUN_EVERY_MS);
  return controlWrite(() =>
    db
      .update(controlBoxes)
      .set({ runRequestedAt: null })
      .where(
        or(
          isNotNull(controlBoxes.runRequestedAt),
          isNull(controlBoxes.lastRunAt),
          lte(controlBoxes.lastRunAt, cutoff),
        ),
      )
      .returning(BOX_COLUMNS),
  );
}

/** The bans a run reads: the active ones, and the lifted disable bans (for
 *  the enable of what they disabled). */
export async function runControlBans(): Promise<ControlBan[]> {
  return db
    .select()
    .from(controlBans)
    .where(or(isNull(controlBans.liftedAt), eq(controlBans.kind, 'disable')));
}

export async function saveControlRun(
  boxId: string,
  run: {
    reason: string | null;
    result?: Record<string, unknown>;
    logins?: ControlLogin[];
    perBan?: BoxPlan['perBan'];
  },
): Promise<void> {
  await controlWrite(() =>
    db.transaction(async (tx) => {
      await tx
        .update(controlBoxes)
        .set({
          lastRunAt: sql`now()`,
          lastReason: run.reason,
          ...(run.reason === null ? { lastOkAt: sql`now()` } : {}),
          ...(run.result ? { lastResult: run.result } : {}),
          ...(run.logins ? { logins: run.logins } : {}),
        })
        .where(eq(controlBoxes.id, boxId));
      if (!run.perBan) return;
      for (const [banId, r] of run.perBan) {
        await tx
          .insert(controlResults)
          .values({ banId, boxId, matched: r.matched, ownerIds: r.ownerIds })
          .onConflictDoUpdate({
            target: [controlResults.banId, controlResults.boxId],
            set: { matched: r.matched, ownerIds: r.ownerIds, updatedAt: sql`now()` },
          });
      }
    }),
  );
}

// --- the admin channel ---------------------------------------------------------

/** The AAD a tool call's args are sealed with: its box and its id. */
export function controlToolAad(boxId: string, callId: string): string {
  return `control-tool:${boxId}:${callId}`;
}

/** A call not sent within this long is answered `expired`, never sent late. */
export const CONTROL_TOOL_WAIT_MS = 2 * 60_000;
/** An answer is kept until it is read, at most this long. */
export const CONTROL_TOOL_KEEP_MS = 10 * 60_000;
/** The most calls one box holds: waiting, or answered and not read yet. */
export const CONTROL_MAX_WAITING_TOOLS = 10;

/** A call as a reader gets it: never its sealed args. */
export type ControlToolView = Omit<ControlToolCall, 'sealed'> & { boxId: string };

const ageMs = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : 0);

/** The calls with the old ones gone: an unsent call past its wait is
 *  answered `expired` (its args dropped); an answer past its keep, and a
 *  sent call that never came back by then, are deleted. */
function prunedToolCalls(calls: readonly ControlToolCall[], now: number): ControlToolCall[] {
  const out: ControlToolCall[] = [];
  for (const c of calls) {
    // An answer is kept from when it came; a sent call that never came back,
    // from when it was sent (a slow box's answer still finds its row).
    const from = c.done ?? c.sentAt ?? c.at;
    if (ageMs(from, now) > CONTROL_TOOL_KEEP_MS) continue;
    if (!c.sentAt && !c.done && ageMs(c.at, now) > CONTROL_TOOL_WAIT_MS) {
      out.push({
        ...c,
        sealed: null,
        done: new Date(now).toISOString(),
        ok: false,
        reason: 'expired',
      });
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Every write of tool_job, at the spot control-center: each box's calls
 *  (pruned first), handed to `edit`, which answers the new list, what to
 *  return, and whether to ask for the box's run now. One transaction per
 *  box, holding that one row: it never waits on a row while holding
 *  another, so it cannot deadlock with a run's take of the boxes due. */
async function editToolJobs<T>(
  boxIds: readonly string[] | null,
  edit: (
    boxId: string,
    calls: ControlToolCall[],
  ) => { calls: ControlToolCall[]; out?: T; run?: boolean },
): Promise<T[]> {
  const ids = (
    await db
      .select({ id: controlBoxes.id })
      .from(controlBoxes)
      .where(
        boxIds ? inArray(controlBoxes.id, [...boxIds]) : sql`${controlBoxes.toolJob} is not null`,
      )
      .orderBy(asc(controlBoxes.id))
  ).map((r) => r.id);
  const outs: T[] = [];
  for (const id of ids) {
    const out = await controlWrite(() =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ toolJob: controlBoxes.toolJob })
          .from(controlBoxes)
          .where(eq(controlBoxes.id, id))
          .for('update');
        if (!row) return undefined; // removed meanwhile
        const before = row.toolJob?.calls ?? [];
        const r = edit(id, prunedToolCalls(before, Date.now()));
        const same = JSON.stringify(r.calls) === JSON.stringify(before);
        if (!same || r.run) {
          await tx
            .update(controlBoxes)
            .set({
              toolJob: r.calls.length ? { calls: r.calls } : null,
              ...(r.run ? { runRequestedAt: sql`now()` } : {}),
            })
            .where(eq(controlBoxes.id, id));
        }
        return r.out;
      }),
    );
    if (out !== undefined) outs.push(out);
  }
  return outs;
}

/**
 * Queues one admin channel call for each box of `boxIds` and asks for
 * their run now: `tool` with its name and args (`seal(boxId, callId)`
 * seals them; the caller holds the master key's code), or `tools`. A box
 * that already has CONTROL_MAX_WAITING_TOOLS calls waiting is not queued.
 * Returns each queued box and its call id.
 */
export async function queueControlToolCalls(
  boxIds: readonly string[],
  call:
    | { kind: 'tool'; name: string; seal: (boxId: string, callId: string) => string }
    | { kind: 'tools' }
    | {
        kind: 'sso';
        name: ControlSsoCase;
        seal?: (boxId: string, callId: string) => string;
      }
    | { kind: 'invite'; seal: (boxId: string, callId: string) => string },
  by: string,
): Promise<{ boxId: string; callId: string }[]> {
  const at = new Date().toISOString();
  return editToolJobs(boxIds, (boxId, calls) => {
    // Answers not read yet count too: they are held until read (or 10 min).
    if (calls.length >= CONTROL_MAX_WAITING_TOOLS) return { calls };
    const id = randomUUID();
    const made: ControlToolCall =
      call.kind === 'tools'
        ? { id, kind: 'tools', name: null, sealed: null, by, at }
        : {
            id,
            kind: call.kind,
            name: call.kind === 'invite' ? 'invite' : call.name,
            sealed: call.seal ? call.seal(boxId, id) : null,
            by,
            at,
          };
    return { calls: [...calls, made], out: { boxId, callId: id }, run: true };
  });
}

/** The control service: takes the box's unsent calls (marked sent, their
 *  sealed args dropped from the row) and returns them, args still sealed.
 *  Each is sent once: a second take finds none. */
export async function takeControlToolCalls(boxId: string): Promise<ControlToolCall[]> {
  const taken = await editToolJobs<ControlToolCall[]>([boxId], (_id, calls) => {
    const now = new Date().toISOString();
    const out = calls.filter((c) => !c.sentAt && !c.done);
    if (out.length === 0) return { calls };
    return {
      calls: calls.map((c) => (!c.sentAt && !c.done ? { ...c, sealed: null, sentAt: now } : c)),
      out,
    };
  });
  return taken[0] ?? [];
}

/** The control service: the box's answer to the call `callId`. */
export async function saveControlToolAnswer(
  boxId: string,
  callId: string,
  answer: Pick<ControlToolCall, 'ok' | 'reason' | 'output' | 'error' | 'truncated'>,
): Promise<void> {
  const done = new Date().toISOString();
  await editToolJobs([boxId], (_id, calls) => ({
    calls: calls.map((c) => (c.id === callId ? { ...c, ...answer, sealed: null, done } : c)),
  }));
}

/** The calls `callIds` names, for the CC Admin who asked. With `take`, the
 *  answered ones are deleted as they are read: an answer is kept only as
 *  long as the asker needs it. */
export async function readControlToolCalls(
  callIds: readonly string[],
  take: boolean,
): Promise<ControlToolView[]> {
  const want = new Set(callIds.map((id) => id.toLowerCase()));
  // A plain read first; only the boxes that hold an answer to take are
  // locked, so a waiting asker's polls hold back no run.
  const rows = await db
    .select({ id: controlBoxes.id, toolJob: controlBoxes.toolJob })
    .from(controlBoxes)
    .where(sql`${controlBoxes.toolJob} is not null`);
  const views = (boxId: string, calls: readonly ControlToolCall[]) =>
    calls
      .filter((c) => want.has(c.id))
      .map(({ sealed, ...rest }) => {
        void sealed;
        return { ...rest, boxId };
      });
  const holding = rows.filter((r) =>
    (r.toolJob?.calls ?? []).some((c) => want.has(c.id) && c.done),
  );
  if (!take || holding.length === 0)
    return rows.flatMap((r) => views(r.id, r.toolJob?.calls ?? []));
  const found = await editToolJobs<ControlToolView[]>(
    holding.map((r) => r.id),
    (boxId, calls) => {
      const out = views(boxId, calls);
      return { calls: calls.filter((c) => !(want.has(c.id) && c.done)), out };
    },
  );
  const locked = new Set(holding.map((r) => r.id));
  return [
    ...found.flat(),
    ...rows.filter((r) => !locked.has(r.id)).flatMap((r) => views(r.id, r.toolJob?.calls ?? [])),
  ];
}

/** The control service, each tick: the old calls of every box answered
 *  `expired` or deleted (prunedToolCalls). */
export async function expireControlToolCalls(): Promise<void> {
  await editToolJobs(null, (_id, calls) => ({ calls }));
}

/** A tool name as a box's builtins spell one. */
export const CONTROL_TOOL_NAME = /^[a-z][a-z0-9_]{0,79}$/;
/** The longest args one call carries, as JSON (the box's own cap). */
export const CONTROL_TOOL_ARGS_MAX = 32_000;
/** The most boxes one tool call names. */
export const CONTROL_TOOL_MAX_BOXES = 50;
/** How long an ask waits for the answers before it hands back the ids. */
export const CONTROL_TOOL_ANSWER_WAIT_MS = 25_000;
const ANSWER_POLL_MS = 500;

/** One ask of the admin channel: a tool call on `boxIds`, the tool list
 *  of one box (`list`), or the answers of earlier calls (`callIds`). */
export type ControlToolAsk = {
  boxIds?: readonly string[];
  name?: string;
  args?: Record<string, unknown>;
  list?: boolean;
  callIds?: readonly string[];
};

/** The answers that came, and the call ids still on their way (ask
 *  again with `callIds`). Each answer is handed out once. */
export type ControlToolAnswers = {
  answers: ControlToolView[];
  pending: string[];
  /** Ids no box holds: answered and read already, or dropped. */
  gone: string[];
};

/**
 * The one ask of the admin channel (the Fleet tool route, control_tool_call
 * and control_tool_list): queues the calls and asks for the boxes' run now,
 * then waits up to CONTROL_TOOL_ANSWER_WAIT_MS for the answers. `seal`
 * seals a call's args for its box and id (the caller holds the master
 * key's code). The brain signs nothing: the control service sends them.
 */
export async function askControlTools(
  ask: ControlToolAsk,
  by: string,
  seal: (plain: string, aad: string) => string,
  waitMs = CONTROL_TOOL_ANSWER_WAIT_MS,
): Promise<Checked<ControlToolAnswers>> {
  let ids: string[];
  if (ask.callIds !== undefined) {
    if (ask.callIds.length === 0 || ask.callIds.length > 100) {
      return { ok: false, error: 'callIds must name 1 to 100 call ids from an earlier answer.' };
    }
    ids = ask.callIds.map((id) => id.toLowerCase());
  } else {
    const boxIds = [...new Set((ask.boxIds ?? []).map((id) => id.toLowerCase()))];
    const most = ask.list ? 1 : CONTROL_TOOL_MAX_BOXES;
    if (boxIds.length === 0 || boxIds.length > most) {
      return {
        ok: false,
        error: `boxIds must name 1 to ${most} box ids from control_box_list.`,
      };
    }
    let queued: { boxId: string; callId: string }[];
    if (ask.list) {
      queued = await queueControlToolCalls(boxIds, { kind: 'tools' }, by);
    } else {
      const name = (ask.name ?? '').trim();
      if (!CONTROL_TOOL_NAME.test(name)) {
        return {
          ok: false,
          error: 'name must be a tool name from control_tool_list, e.g. agent_list.',
        };
      }
      const args = ask.args ?? {};
      const text = JSON.stringify(args);
      if (Buffer.byteLength(text) > CONTROL_TOOL_ARGS_MAX) {
        return {
          ok: false,
          error: `args must be at most ${CONTROL_TOOL_ARGS_MAX} bytes of JSON.`,
        };
      }
      queued = await queueControlToolCalls(
        boxIds,
        { kind: 'tool', name, seal: (boxId, callId) => seal(text, controlToolAad(boxId, callId)) },
        by,
      );
    }
    if (queued.length === 0) {
      return {
        ok: false,
        error: `No call was queued: no linked box has those ids (control_box_list), or each already has ${CONTROL_MAX_WAITING_TOOLS} calls waiting.`,
      };
    }
    ids = queued.map((q) => q.callId);
  }
  return { ok: true, value: await waitControlAnswers(ids, waitMs) };
}

/** Waits up to `waitMs` for the answers of the calls `ids`, each handed
 *  out once; the rest are pending, or gone (no box holds them). */
async function waitControlAnswers(ids: string[], waitMs: number): Promise<ControlToolAnswers> {
  const answers: ControlToolView[] = [];
  const left = new Set(ids);
  const gone: string[] = [];
  const until = Date.now() + waitMs;
  for (;;) {
    const read = await readControlToolCalls([...left], true);
    const seen = new Set(read.map((v) => v.id));
    for (const id of left) {
      // Not held any more: its answer was handed out, or it was dropped.
      if (!seen.has(id)) {
        left.delete(id);
        gone.push(id);
      }
    }
    for (const v of read) {
      if (!v.done) continue;
      answers.push(v);
      left.delete(v.id);
    }
    if (left.size === 0 || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
  }
  return { answers, pending: [...left], gone };
}

// --- company sign-in from the Control Center (0371) ---------------------------

/** The box's four fixed sign-in cases (server/web lib/control/sso-channel.ts). */
export const CONTROL_SSO_CASES = ['sso_status', 'sso_set', 'sso_test', 'sso_mode'] as const;

/** The modes a CC may raise a box to, one step at a time (0372). */
export const CONTROL_SSO_MODES = ['setup', 'optional', 'required'] as const;
export type ControlSsoMode = (typeof CONTROL_SSO_MODES)[number];
export type ControlSsoCase = (typeof CONTROL_SSO_CASES)[number];

/** The longest client secret (the box's own cap). */
export const CONTROL_SSO_SECRET_MAX = 1024;

/** One box's line on the Company sign-in page. */
export type ControlSsoRow = Pick<ControlBox, 'id' | 'url' | 'label' | 'lastOkAt' | 'lastReason'> & {
  /** The box's version, from its last facts (null before any). */
  version: string | null;
  ssoView: ControlSsoView | null;
};

/** Every box with its sign-in view. */
export async function listControlSso(): Promise<ControlSsoRow[]> {
  const rows = await db
    .select({
      id: controlBoxes.id,
      url: controlBoxes.url,
      label: controlBoxes.label,
      lastOkAt: controlBoxes.lastOkAt,
      lastReason: controlBoxes.lastReason,
      version: sql<string | null>`${controlBoxes.facts}->'status'->'build'->>'version'`,
      ssoView: controlBoxes.ssoView,
    })
    .from(controlBoxes)
    .orderBy(asc(controlBoxes.url));
  return rows.map((r) => ({ ...r, version: r.version ?? null }));
}

/** A box's answer to one sign-in case, as the control service read it. */
export type ControlSsoAnswer = {
  ok: boolean;
  reason: string | null;
  test?: string;
  /** sso_mode: the mode word before the raise. */
  from?: string;
  status?: ControlSsoStatus;
};

/**
 * The view after one answer (pure): the new status when one came (else the
 * one before), the Test's code when a Test ran (sso_test, or sso_set with a
 * new secret in an on mode; a save that went through with no Test clears
 * the last one), the save when the case was sso_set. `reason`:
 * the call's failure code when no status came back (the box did not
 * answer, or refused by scope), else null. The raise when the case was
 * sso_mode (`to`: the mode asked).
 */
export function nextSsoView(
  prev: ControlSsoView | null,
  call: { name: string; by: string; fields: string[]; to?: string },
  answer: ControlSsoAnswer,
  now: string,
): ControlSsoView {
  return {
    at: now,
    reason: answer.status ? null : (answer.reason ?? 'refused'),
    status: answer.status ?? prev?.status ?? null,
    // A save that went through makes the last Test stale (a new secret, or
    // new names that cleared it), unless the save ran its own Test.
    test: answer.test
      ? { code: answer.test, at: now, by: call.by }
      : call.name === 'sso_set' && answer.ok
        ? null
        : (prev?.test ?? null),
    set:
      call.name === 'sso_set'
        ? {
            fields: call.fields,
            ok: answer.ok,
            reason: answer.ok ? null : (answer.reason ?? 'refused'),
            by: call.by,
            at: now,
          }
        : (prev?.set ?? null),
    mode:
      call.name === 'sso_mode'
        ? {
            to: call.to ?? '',
            from: answer.from ?? null,
            ok: answer.ok,
            reason: answer.ok ? null : (answer.reason ?? 'refused'),
            by: call.by,
            at: now,
          }
        : (prev?.mode ?? null),
  };
}

/** The control service: a box's answer to a sign-in case, into its view. */
export async function saveControlSsoView(
  boxId: string,
  call: { name: string; by: string; fields: string[]; to?: string },
  answer: ControlSsoAnswer,
): Promise<void> {
  await controlWrite(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ ssoView: controlBoxes.ssoView })
        .from(controlBoxes)
        .where(eq(controlBoxes.id, boxId))
        .for('update');
      if (!row) return;
      await tx
        .update(controlBoxes)
        .set({ ssoView: nextSsoView(row.ssoView, call, answer, new Date().toISOString()) })
        .where(eq(controlBoxes.id, boxId));
    }),
  );
}

/** The values of one save, trimmed, the GUIDs lower case: at least one,
 *  each of its shape. The route checks them before its audit row, and the
 *  ask again before it seals them. */
export function checkSsoSet(ask: {
  tenant?: string;
  clientId?: string;
  secret?: string;
}): Checked<{ tenant?: string; clientId?: string; secret?: string }> {
  const args = {
    ...(ask.tenant !== undefined ? { tenant: ask.tenant.trim().toLowerCase() } : {}),
    ...(ask.clientId !== undefined ? { clientId: ask.clientId.trim().toLowerCase() } : {}),
    ...(ask.secret !== undefined ? { secret: ask.secret.trim() } : {}),
  };
  if (Object.keys(args).length === 0) {
    return { ok: false, error: 'Give a tenant ID, a client ID or a client secret.' };
  }
  if (
    (args.tenant !== undefined && !isUuid(args.tenant)) ||
    (args.clientId !== undefined && !isUuid(args.clientId))
  ) {
    return { ok: false, error: 'The tenant ID and the client ID are GUIDs.' };
  }
  if (
    args.secret !== undefined &&
    (args.secret.length === 0 || args.secret.length > CONTROL_SSO_SECRET_MAX)
  ) {
    return { ok: false, error: `The client secret is 1 to ${CONTROL_SSO_SECRET_MAX} characters.` };
  }
  return { ok: true, value: args };
}

/** One ask of the Company sign-in page. */
export type ControlSsoAsk =
  | { do: 'status' | 'test'; boxIds: readonly string[] }
  | { do: 'set'; boxId: string; tenant?: string; clientId?: string; secret?: string }
  | { do: 'mode'; boxId: string; mode: string }
  | { do: 'answers'; callIds: readonly string[] };

/**
 * The one ask of the Company sign-in page (POST /api/fleet/sso, a person
 * only): queues sso_status or sso_test on 1 to 50 boxes, or one sso_set
 * (its args sealed with `seal`, the caller holding the master key's code,
 * and dropped from the row when the control service takes it), asks for the
 * boxes' run now, and waits for the answers as the tool ask does. The plain
 * secret is in this call's memory only. `mode` queues one sso_mode (the mode
 * asked, sealed as a save's values are; the box holds the step rule).
 */
export async function askControlSso(
  ask: ControlSsoAsk,
  by: string,
  seal: (plain: string, aad: string) => string,
  waitMs = CONTROL_TOOL_ANSWER_WAIT_MS,
): Promise<Checked<ControlToolAnswers>> {
  if (ask.do === 'answers') {
    if (ask.callIds.length === 0 || ask.callIds.length > 100) {
      return { ok: false, error: 'callIds must name 1 to 100 call ids from an earlier answer.' };
    }
    return {
      ok: true,
      value: await waitControlAnswers(
        ask.callIds.map((id) => id.toLowerCase()),
        waitMs,
      ),
    };
  }
  let queued: { boxId: string; callId: string }[];
  if (ask.do === 'mode') {
    if (!(CONTROL_SSO_MODES as readonly string[]).includes(ask.mode)) {
      return { ok: false, error: 'The mode is setup, optional or required.' };
    }
    const text = JSON.stringify({ mode: ask.mode });
    queued = await queueControlToolCalls(
      [ask.boxId.toLowerCase()],
      {
        kind: 'sso',
        name: 'sso_mode',
        seal: (boxId, callId) => seal(text, controlToolAad(boxId, callId)),
      },
      by,
    );
  } else if (ask.do === 'set') {
    const checked = checkSsoSet(ask);
    if (!checked.ok) return checked;
    const text = JSON.stringify(checked.value);
    queued = await queueControlToolCalls(
      [ask.boxId.toLowerCase()],
      {
        kind: 'sso',
        name: 'sso_set',
        seal: (boxId, callId) => seal(text, controlToolAad(boxId, callId)),
      },
      by,
    );
  } else {
    const boxIds = [...new Set(ask.boxIds.map((id) => id.toLowerCase()))];
    if (boxIds.length === 0 || boxIds.length > CONTROL_TOOL_MAX_BOXES) {
      return { ok: false, error: `boxIds must name 1 to ${CONTROL_TOOL_MAX_BOXES} box ids.` };
    }
    queued = await queueControlToolCalls(
      boxIds,
      { kind: 'sso', name: ask.do === 'status' ? 'sso_status' : 'sso_test' },
      by,
    );
  }
  if (queued.length === 0) {
    return {
      ok: false,
      error: `No call was queued: no linked box has those ids, or each already has ${CONTROL_MAX_WAITING_TOOLS} calls waiting.`,
    };
  }
  return {
    ok: true,
    value: await waitControlAnswers(
      queued.map((q) => q.callId),
      waitMs,
    ),
  };
}

// --- a member invite from the Control Center ------------------------------------

/** The longest email an invite names (the box's own invite route's cap). */
export const CONTROL_INVITE_EMAIL_MAX = 320;
/** The longest one-time public key an invite carries: base64 of an RSA
 *  public key (SPKI, DER) of 2048 to 4096 bits. */
export const CONTROL_INVITE_KEY_MAX = 1024;

/** Whether an active ban names `email` (lowercase). The CC refuses an
 *  invite for it: the bans never leave the CC, so the box cannot. */
export async function controlBanNamesEmail(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: controlBans.id })
    .from(controlBans)
    .where(and(isNull(controlBans.liftedAt), sql`${email} = any(${controlBans.emails})`))
    .limit(1);
  return !!row;
}

/** One ask of the Fleet users invite (POST /api/fleet/invite, a person
 *  only): one box makes a member invite for `email`, its code locked to
 *  the one-time public key `key`; or the answers of earlier asks. */
export type ControlInviteAsk =
  | { do: 'invite'; boxId: string; email: string; key: string }
  | { do: 'answers'; callIds: readonly string[] };

/**
 * Queues one `invite` call (the email and the public key sealed with the
 * CC master key, `seal`, and dropped from the row when the control service
 * takes it), asks for the box's run now, and waits for the answer as the
 * tool ask does. The answer holds the code locked to `key` only: the row
 * never holds a code the CC can read.
 */
export async function askControlInvite(
  ask: ControlInviteAsk,
  by: string,
  seal: (plain: string, aad: string) => string,
  waitMs = CONTROL_TOOL_ANSWER_WAIT_MS,
): Promise<Checked<ControlToolAnswers>> {
  if (ask.do === 'answers') {
    if (ask.callIds.length === 0 || ask.callIds.length > 100) {
      return { ok: false, error: 'callIds must name 1 to 100 call ids from an earlier answer.' };
    }
    return {
      ok: true,
      value: await waitControlAnswers(
        ask.callIds.map((id) => id.toLowerCase()),
        waitMs,
      ),
    };
  }
  const text = JSON.stringify({ email: ask.email, key: ask.key });
  const queued = await queueControlToolCalls(
    [ask.boxId.toLowerCase()],
    { kind: 'invite', seal: (boxId, callId) => seal(text, controlToolAad(boxId, callId)) },
    by,
  );
  if (queued.length === 0) {
    return {
      ok: false,
      error: `No call was queued: no linked box has that id, or it already has ${CONTROL_MAX_WAITING_TOOLS} calls waiting.`,
    };
  }
  return {
    ok: true,
    value: await waitControlAnswers(
      queued.map((q) => q.callId),
      waitMs,
    ),
  };
}
