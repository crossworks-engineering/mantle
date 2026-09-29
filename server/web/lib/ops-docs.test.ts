import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Operator docs that state facts about shell scripts and compose. Nothing
 * type-checks those, and the 2026-09-28 audit found four of them stale at
 * once: security.md promised a backup before every roll that no code took,
 * access-levels.md said restore creates three roles (it creates four),
 * member-logins.md left the maintenance worker off the MANTLE_SPACES_ROOT
 * list, and no doc named the rollback floor migration 0178 set. Each check
 * here reads the fact from the code and asks the doc to state it.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const oneLine = (s: string) => s.replace(/\s+/g, ' ');

describe('ops docs match the code', () => {
  it('access-levels.md names every role db-restore.sh creates, and how many', () => {
    const restore = read('scripts/db-restore.sh');
    const list = restore.match(/FOREACH r IN ARRAY ARRAY\[([^\]]+)\]/);
    expect(list, 'role list not found in db-restore.sh').toBeTruthy();
    const roles = [...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(roles.length).toBeGreaterThan(0);
    const doc = oneLine(read('docs/access-levels.md'));
    const restoreLine = doc.match(
      /\*\*Restore\*\* \(`scripts\/db-restore\.sh`\) creates the (\w+) roles \(([^)]*)\)/,
    );
    expect(restoreLine, 'the Restore bullet is gone from access-levels.md').toBeTruthy();
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
    expect(restoreLine![1]).toBe(words[roles.length]);
    for (const r of roles) expect(restoreLine![2], `${r} not named`).toContain(r);
  });

  it('member-logins.md names every service that carries MANTLE_SPACES_ROOT', () => {
    const compose = read('docker-compose.yml');
    // Service blocks: a two-space-indented key under `services:`, up to the next.
    const services: string[] = [];
    const blocks = compose.split(/\n(?= {2}[a-z_]+:\n)/);
    for (const b of blocks) {
      const name = b.match(/^ {2}([a-z_]+):\n/)?.[1];
      if (name && /^\s+MANTLE_SPACES_ROOT:/m.test(b)) services.push(name);
    }
    expect(services.length).toBeGreaterThan(0);
    const doc = oneLine(read('docs/member-logins.md'));
    const para = doc.match(/(\w+) services carry `MANTLE_SPACES_ROOT`:([^;]*)/);
    expect(para, 'the MANTLE_SPACES_ROOT sentence is gone from member-logins.md').toBeTruthy();
    const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    expect(para![1]).toBe(words[services.length]);
    for (const s of services) {
      const phrase = s.startsWith('worker_') ? `${s.slice('worker_'.length)} worker` : s;
      expect(para![2], `${s} not named`).toContain(phrase);
    }
  });

  it('the pre-roll backup the docs promise is the one the updater takes', () => {
    const updater = read('infra/updater/updater.sh');
    const dir = updater.match(/^PRE_ROLL_REL=(\S+)$/m)?.[1];
    expect(dir, 'PRE_ROLL_REL not found in updater.sh').toBeTruthy();
    // The roll refuses to start without it: the call sits before the first
    // change a server roll makes.
    const loop = updater.slice(updater.indexOf('# ── poll loop'));
    const gate = loop.indexOf('if ! pre_roll_backup; then');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(loop.indexOf('persist_env MANTLE_IMAGE_TAG'));
    expect(gate).toBeLessThan(loop.indexOf('refresh_compose "$TARGET"'));
    const security = read('docs/security.md');
    const updateProd = read('docs/update-prod.md');
    expect(security).toContain(`\`${dir}/\``);
    expect(updateProd).toContain(`\`${dir}/\``);
    // Every .env knob the updater reads for it is documented.
    const knobs = [...updater.matchAll(/env_val (MANTLE_(?:PRE_ROLL|IMAGE_PRUNE)\w*)/g)].map(
      (m) => m[1]!,
    );
    expect(new Set(knobs)).toEqual(
      new Set([
        'MANTLE_PRE_ROLL_BACKUP',
        'MANTLE_PRE_ROLL_MIN_FREE_MB',
        'MANTLE_PRE_ROLL_KEEP',
        'MANTLE_IMAGE_PRUNE',
      ]),
    );
    for (const k of knobs) expect(updateProd, `${k} undocumented`).toContain(k);
  });

  it('security.md no longer lists the retired team-app link or a single-owner brain', () => {
    const security = read('docs/security.md');
    expect(security).not.toMatch(/\*\*team app\*\*/);
    expect(security).not.toMatch(/single-owner/);
    expect(security).not.toMatch(/no in-brain\s+tiered read ACLs/);
  });

  it('update-prod.md states the client logins floor the updater enforces, and its knob', () => {
    const updater = read('infra/updater/updater.sh');
    const floor = updater.match(/^CLIENT_FLOOR=(\d+\.\d+\.\d+)$/m)?.[1];
    expect(floor, 'CLIENT_FLOOR not found in updater.sh').toBeTruthy();
    const doc = oneLine(read('docs/update-prod.md'));
    const floors = doc.slice(doc.search(/never roll back below/i));
    expect(floors).toContain(`**v${floor} once any client login exists**`);
    const knob = updater.match(/env_val (MANTLE_ALLOW_BELOW_CLIENT_FLOOR)\)/)?.[1];
    expect(knob, 'the override knob is not read by updater.sh').toBeTruthy();
    expect(doc).toContain(knob!);
    // The refusal sits before the pre-roll backup: nothing changes first.
    const loop = updater.slice(updater.indexOf('# ── poll loop'));
    const refusal = loop.indexOf('if client_floor_refusal "$TARGET"; then');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(loop.indexOf('if ! pre_roll_backup; then'));
  });

  it('both rollback docs state the 0178 floor', () => {
    for (const p of ['docs/update-prod.md', 'docs/member-logins.md']) {
      const doc = oneLine(read(p));
      expect(doc, p).toMatch(/never roll back below/i);
      expect(doc, p).toMatch(/0178[^.]*v0\.232\.301|v0\.232\.301[^.]*0178/);
    }
  });
});
