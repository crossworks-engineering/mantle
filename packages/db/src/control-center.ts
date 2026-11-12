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
import { createHash } from 'node:crypto';
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
import { db } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import {
  controlBans,
  controlBoxes,
  controlResults,
  controlService,
  CONTROL_MAX_WRITE_CHANGES,
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
export type ControlBoxRow = Omit<ControlBox, 'facts'>;
const BOX_COLUMNS = (() => {
  const { facts, ...rest } = getTableColumns(controlBoxes);
  void facts;
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
  const list = (input ?? []).map((raw) => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as { slug?: unknown; model?: unknown };
    return {
      slug: typeof c.slug === 'string' ? c.slug.trim().toLowerCase() : '',
      model: typeof c.model === 'string' ? c.model.trim() : '',
    };
  });
  if (list.length === 0 || list.length > CONTROL_MAX_WRITE_CHANGES) {
    return { ok: false, error: `Give 1 to ${CONTROL_MAX_WRITE_CHANGES} changes.` };
  }
  for (const c of list) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.slug)) {
      return { ok: false, error: 'Each slug must be an agent the system ships, e.g. coder.' };
    }
    if (!CONTROL_MODEL_ID.test(c.model)) {
      return { ok: false, error: 'Each model must be a model id, e.g. vendor/model-name.' };
    }
  }
  if (new Set(list.map((c) => c.slug)).size !== list.length) {
    return { ok: false, error: 'Name each slug once.' };
  }
  return { ok: true, value: list.map((c) => ({ kind: 'agentModel' as const, ...c })) };
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
      const model = text(c.model);
      if (!SLUG.test(worker)) {
        return { ok: false, error: 'workerModel needs a worker kind, e.g. summarizer.' };
      }
      if (!CONTROL_MODEL_ID.test(model)) {
        return { ok: false, error: 'workerModel needs a model id, e.g. vendor/model-name.' };
      }
      out.push({ kind: 'workerModel', worker, model });
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
