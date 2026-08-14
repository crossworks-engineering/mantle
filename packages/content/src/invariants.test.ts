import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cross-artifact invariants: rules that live in TWO files which must agree,
 * where nothing else in the pipeline notices when they stop agreeing.
 *
 * The motivating failure (v0.202.1 → v0.206.2): the Dockerfile installed
 * postgresql-client-18 while `resolvePgDump` still looked for 17, the operator
 * error strings told people to install 17, and docs/backups.md documented 17.
 * `pg_dump` REFUSES a server newer than itself, so a client older than
 * POSTGRES_IMAGE_TAG aborts every dump — in the backup path, the last place a
 * silent half-fix is affordable. It went undetected for two days because each
 * file is individually correct-looking; only the PAIR is wrong.
 *
 * Typecheck, lint and the test suite were all green throughout. This file is
 * the guard. Precedent: packages/app-build/src/kit.test.ts, the @host kit ↔
 * bridge protocol mirror tripwire.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const DOCKERFILE = 'Dockerfile';
const COMPOSE = 'docker-compose.yml';
const COMPOSE_DEV = 'docker-compose.dev.yml';
const COMPOSE_CORE = 'docker-compose.core.yml';
const BACKUP = 'packages/content/src/backup.ts';

/** Service names declared under a compose file's top-level `services:` key. */
function composeServices(rel: string): string[] {
  const lines = read(rel).split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  if (start < 0) throw new Error(`no top-level services: key in ${rel}`);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^ {2}([a-z][a-z0-9_]*):\s*$/);
    if (m) names.push(m[1]!);
  }
  return names;
}

/** Major version of the Postgres client apt-installed into the server image. */
function dockerfileClientMajor(): number {
  const m = read(DOCKERFILE).match(/postgresql-client-(\d+)/);
  if (!m) throw new Error(`no postgresql-client-<major> found in ${DOCKERFILE}`);
  return Number(m[1]);
}

/** Major version of the Postgres SERVER a compose file defaults to, read from
 *  the `${POSTGRES_IMAGE_TAG:-pgNN}` fallback (the value a box gets when it
 *  sets nothing — which is the case that has to be safe out of the box). */
function composeServerMajor(rel: string): number {
  const m = read(rel).match(/POSTGRES_IMAGE_TAG:-pg(\d+)/);
  if (!m) throw new Error(`no \${POSTGRES_IMAGE_TAG:-pg<major>} default found in ${rel}`);
  return Number(m[1]);
}

/** The literal candidate list inside resolvePgDump(), in order. */
function pgDumpCandidates(): string[] {
  const src = read(BACKUP);
  const block = src.match(/const candidates = \[([\s\S]*?)\];/);
  if (!block) throw new Error(`could not find the candidates array in ${BACKUP}`);
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('brain-core override ↔ main compose', () => {
  // docker-compose.core.yml shrinks the stack by adding `profiles: ["full"]`
  // to services the main file defines. Compose treats an override entry for an
  // UNKNOWN service as a definition, not an error — so a service renamed in
  // docker-compose.yml would silently escape the core gate and start on every
  // 4 GB core box at its next update. Only the pair is checkable.
  it(`every service ${COMPOSE_CORE} gates exists in ${COMPOSE}`, () => {
    const main = composeServices(COMPOSE);
    for (const svc of composeServices(COMPOSE_CORE)) {
      expect(
        main,
        `${COMPOSE_CORE} gates '${svc}' but ${COMPOSE} defines no such service — ` +
          `renamed or removed? Update the core override in the same change.`,
      ).toContain(svc);
    }
  });

  it(`${COMPOSE_CORE} only ever ADDS profile gates (never redefines a service)`, () => {
    const body = read(COMPOSE_CORE)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
      .filter((l) => !/^services:$/.test(l));
    for (const line of body) {
      expect(
        /^ {2}[a-z][a-z0-9_]*:$/.test(line) || /^ {4}profiles: \["full"(, "helpers")?\]$/.test(line),
        `${COMPOSE_CORE} must stay a pure profile gate; unexpected line: ${JSON.stringify(line)}. ` +
          `Real overrides belong in docker-compose.yml (full) or a box's docker-compose.override.yml.`,
      ).toBe(true);
    }
  });

  it(`the doc helpers (tika + browser) carry the helpers profile, channel workers don't`, () => {
    // install.sh --helpers re-enables exactly the stateless parse/render pair
    // on a core box. A channel worker slipping into the helpers profile would
    // come back with them — this pins the split.
    const src = read(COMPOSE_CORE);
    const gates = new Map(
      [...src.matchAll(/^ {2}([a-z][a-z0-9_]*):\n {4}profiles: (\[[^\]]*\])$/gm)].map((m) => [
        m[1]!,
        m[2]!,
      ]),
    );
    for (const [svc, profiles] of gates) {
      const wantHelpers = svc === 'tika' || svc === 'browser';
      expect(
        profiles,
        `${COMPOSE_CORE}: '${svc}' has profiles ${profiles} — ` +
          (wantHelpers
            ? `the doc helpers must be ["full", "helpers"] so --helpers brings them back.`
            : `only tika/browser may carry "helpers"; everything else is full-shape only.`),
      ).toBe(wantHelpers ? '["full", "helpers"]' : '["full"]');
    }
  });
});

describe('pg client ↔ server major', () => {
  it(`${DOCKERFILE}'s client is at least as new as ${COMPOSE}'s default server`, () => {
    const client = dockerfileClientMajor();
    const server = composeServerMajor(COMPOSE);
    expect(
      client,
      `${DOCKERFILE} installs postgresql-client-${client} but ${COMPOSE} defaults ` +
        `POSTGRES_IMAGE_TAG to pg${server}. pg_dump refuses a server newer than itself, ` +
        `so EVERY backup would abort. Bump postgresql-client-N in ${DOCKERFILE} to >= ${server} ` +
        `and add /usr/lib/postgresql/${server}/bin/pg_dump to resolvePgDump in ${BACKUP}.`,
    ).toBeGreaterThanOrEqual(server);
  });

  it(`${DOCKERFILE}'s client is at least as new as ${COMPOSE_DEV}'s default server`, () => {
    const client = dockerfileClientMajor();
    const server = composeServerMajor(COMPOSE_DEV);
    expect(
      client,
      `${DOCKERFILE} installs postgresql-client-${client} but ${COMPOSE_DEV} defaults to ` +
        `pg${server}. The dev stack would fail to back up. Keep the two composes in step.`,
    ).toBeGreaterThanOrEqual(server);
  });
});

describe('resolvePgDump candidate ordering', () => {
  it('offers an explicit pgdg path for the major the image actually installs', () => {
    const client = dockerfileClientMajor();
    const wanted = `/usr/lib/postgresql/${client}/bin/pg_dump`;
    expect(
      pgDumpCandidates(),
      `${DOCKERFILE} installs postgresql-client-${client}, so ${BACKUP} must list ` +
        `${wanted} among its candidates — otherwise the image ships a client the ` +
        `resolver never reaches.`,
    ).toContain(wanted);
  });

  it('checks the newest pgdg path BEFORE the bare PATH name', () => {
    const candidates = pgDumpCandidates();
    const client = dockerfileClientMajor();
    const newest = candidates.indexOf(`/usr/lib/postgresql/${client}/bin/pg_dump`);
    const bare = candidates.indexOf('pg_dump');
    expect(bare, `${BACKUP} must keep a bare 'pg_dump' PATH candidate`).toBeGreaterThanOrEqual(0);
    // Ordering IS the fix. canRun() only probes `--version`, which an OLDER
    // client passes happily before aborting on a newer server — so a host with
    // both clients installed silently picks wrong unless the newest explicit
    // path is checked first.
    expect(
      newest,
      `${BACKUP}: /usr/lib/postgresql/${client}/bin/pg_dump must come BEFORE the bare ` +
        `'pg_dump' PATH entry. canRun() only probes --version, which an older client ` +
        `passes before aborting on a pg${client} server, so PATH-first resolves wrong ` +
        `on any host carrying two clients.`,
    ).toBeLessThan(bare);
  });

  it('orders every explicit pgdg path newest-first', () => {
    const majors = pgDumpCandidates()
      .map((c) => c.match(/\/usr\/lib\/postgresql\/(\d+)\/bin\/pg_dump/)?.[1])
      .filter((m): m is string => Boolean(m))
      .map(Number);
    expect(
      majors,
      `${BACKUP}: explicit /usr/lib/postgresql/<major>/ candidates must be newest-first — ` +
        `the highest installed client is the only always-safe pick.`,
    ).toEqual([...majors].sort((a, b) => b - a));
  });
});

describe('operator-facing backup errors', () => {
  it('never hardcodes a Postgres major', () => {
    // These strings tell an operator how to fix a failed dump. Naming a major
    // makes them go stale the moment the image or compose default moves — which
    // is exactly what happened: they said "install 17" for two days after the
    // image had already moved to 18.
    const src = read(BACKUP);
    const mentions = src.match(/Install a Postgres client/g) ?? [];
    const versionless = src.match(/Install a Postgres client at least as new as the server/g) ?? [];
    expect(mentions.length, `expected the pg_dump advice strings in ${BACKUP}`).toBeGreaterThan(0);
    expect(
      versionless.length,
      `${BACKUP}: every "Install a Postgres client" must continue "at least as new as the ` +
        `server". Naming a major dates the advice — ${mentions.length} mention(s), only ` +
        `${versionless.length} version-agnostic.`,
    ).toBe(mentions.length);
  });

  it('keeps the resolver comment in step with the image it describes', () => {
    // resolvePgDump's doc comment explains WHY the order is what it is, and to
    // do that it names the client the image ships and the server compose
    // defaults to. That makes it a THIRD copy of the same two numbers — useful
    // prose, and one more thing that can quietly go stale. So pin it rather
    // than ban it: the comment may name a major, but only the right one.
    const src = read(BACKUP);
    for (const [, major] of src.matchAll(/postgresql-client-(\d+)/g)) {
      expect(
        Number(major),
        `${BACKUP} describes postgresql-client-${major}, but ${DOCKERFILE} installs ` +
          `postgresql-client-${dockerfileClientMajor()}. Update the comment.`,
      ).toBe(dockerfileClientMajor());
    }
    for (const [, major] of src.matchAll(/POSTGRES_IMAGE_TAG=pg(\d+)/g)) {
      expect(
        Number(major),
        `${BACKUP} describes POSTGRES_IMAGE_TAG=pg${major}, but ${COMPOSE} defaults to ` +
          `pg${composeServerMajor(COMPOSE)}. Update the comment.`,
      ).toBe(composeServerMajor(COMPOSE));
    }
  });
});
