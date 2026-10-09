/**
 * The boot reconcile's two Phase 6 steps on Postgres:
 *
 *   - upgradeUneditedPrompts: a team-responder whose prompt is still an
 *     earlier shipped default gets the current default, through the Studio's
 *     prose versioning (the old text is v1, one revert away); an edited prompt
 *     and an already-current one are left alone; a second run does nothing.
 *   - disableRetiredManifestItems: the retired `team-notify` group and the
 *     builtin `team_member_list` / `team_notify` / `my_app_share` rows are
 *     disabled; an operator's own http tool that shares a slug is not.
 *
 * The real retired hashes are checked against git history in manifest.test.ts;
 * here one synthetic old default is added to them, so the brains can be seeded
 * without copying an old prompt into the test.
 * Seeds its own brain rows; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/prompt-upgrade.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const OLD = 'You are the Team Responder. A default from an earlier release.';

vi.mock('./manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./manifest')>();
  const old = createHash('sha256').update(OLD, 'utf8').digest('hex');
  return {
    ...actual,
    MANIFEST_AGENTS: actual.MANIFEST_AGENTS.map((a) =>
      a.slug === 'team-responder'
        ? { ...a, retiredPromptSha256: [...(a.retiredPromptSha256 ?? []), old] }
        : a,
    ),
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)('reconcile: unedited prompts and retired items', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let rec: typeof import('./reconcile');
  let current = '';
  const brains = { unedited: randomUUID(), edited: randomUUID(), fresh: randomUUID() };
  const EDITED = `${OLD} Always answer in Afrikaans.`;

  const agentOf = async (owner: string) =>
    (
      await admin<Row[]>`select id, system_prompt from agents
                          where owner_id = ${owner} and slug = 'team-responder'`
    )[0]!;
  const versionsOf = async (agentId: unknown) =>
    admin<Row[]>`select version, body, note from prompt_versions
                  where entity_type = 'agent' and entity_id = ${agentId as string}
                    and field = 'system_prompt' order by version`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    rec = await import('./reconcile');
    current = (await import('./manifest')).MANIFEST_AGENTS.find(
      (a) => a.slug === 'team-responder',
    )!.systemPrompt!;
    const prompts = { unedited: OLD, edited: EDITED, fresh: current };
    for (const [k, owner] of Object.entries(brains)) {
      await admin`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`pu-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into agents (owner_id, slug, name, model, system_prompt)
                  values (${owner}, 'team-responder', 'Team Responder', 'test/model',
                          ${prompts[k as keyof typeof prompts]})`;
    }
    // Retired items: on the unedited brain, the builtin rows and the group; on
    // the edited brain, an operator's own http tool that shares a slug.
    const u = brains.unedited;
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs)
                values (${u}, 'team-notify', 'Team notifications',
                        ${['team_member_list', 'team_notify']})`;
    // my_app_share: a builtin row an older brain seeded, no handler since N1.
    for (const slug of ['team_member_list', 'team_notify', 'my_app_share']) {
      await admin`insert into tools (owner_id, slug, name, description, handler)
                  values (${u}, ${slug}, ${slug}, 'x', ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)`;
    }
    await admin`insert into tools (owner_id, slug, name, description, handler)
                values (${brains.edited}, 'team_notify', 'My notifier', 'x',
                        ${JSON.stringify({ kind: 'http', url: 'https://example.invalid' })}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const owners = Object.values(brains);
    await admin`delete from prompt_versions where owner_id in ${admin(owners)}`;
    await admin`delete from tools where owner_id in ${admin(owners)}`;
    await admin`delete from tool_groups where owner_id in ${admin(owners)}`;
    await admin`delete from agents where owner_id in ${admin(owners)}`;
    await admin`delete from spaces where id in ${admin(owners)}`;
    await admin`delete from auth.users where id in ${admin(owners)}`;
    await m.closeDb();
  });

  it('moves an unedited default to the current one, keeping the old as v1', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.unedited)).toEqual(['team-responder']);
    const a = await agentOf(brains.unedited);
    expect(a.system_prompt).toBe(current);
    const v = await versionsOf(a.id);
    expect(v.map((r) => [r.version, r.body])).toEqual([
      [1, OLD],
      [2, current],
    ]);
    expect(String(v[1]!.note)).toMatch(/unedited/);
  });

  it('keeps an edited prompt, and one that is already current', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.edited)).toEqual([]);
    expect(await rec.upgradeUneditedPrompts(brains.fresh)).toEqual([]);
    const e = await agentOf(brains.edited);
    expect(e.system_prompt).toBe(EDITED);
    expect(await versionsOf(e.id)).toEqual([]);
    expect((await agentOf(brains.fresh)).system_prompt).toBe(current);
  });

  it('a second run changes nothing', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.unedited)).toEqual([]);
    expect(await versionsOf((await agentOf(brains.unedited)).id)).toHaveLength(2);
  });

  it('disables the retired group and builtin tools, not an operator tool', async () => {
    expect((await rec.disableRetiredManifestItems(brains.unedited)).sort()).toEqual([
      'group team-notify',
      'tool my_app_share',
      'tool team_member_list',
      'tool team_notify',
    ]);
    const owners = [brains.unedited, brains.edited];
    const rows = await admin<Row[]>`
      select owner_id, slug, enabled from tools
       where owner_id in ${admin(owners)} order by owner_id, slug`;
    const enabled = Object.fromEntries(rows.map((r) => [`${r.owner_id}:${r.slug}`, r.enabled]));
    expect(enabled[`${brains.unedited}:team_member_list`]).toBe(false);
    expect(enabled[`${brains.unedited}:team_notify`]).toBe(false);
    expect(enabled[`${brains.unedited}:my_app_share`]).toBe(false);
    expect(await rec.disableRetiredManifestItems(brains.edited)).toEqual([]);
    expect(enabled[`${brains.edited}:team_notify`]).toBe(true);
    const [g] = await admin<Row[]>`select enabled from tool_groups
                                    where owner_id = ${brains.unedited} and slug = 'team-notify'`;
    expect(g!.enabled).toBe(false);
    expect(await rec.disableRetiredManifestItems(brains.unedited)).toEqual([]);
  });
});
