import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Table-storage capability probes — the "verified foundations" of the Tables v2
 * plan (§2), re-runnable everywhere the storage engine will live: the vitest
 * suite (CI on every branch), the prod image (release workflow), api boot, and
 * the /debug sanity page.
 *
 * `node:sqlite` is flagged experimental upstream, so every behavior Tables v2
 * leans on is probed, not assumed: a probe failing on a new Node line or image
 * means the runtime contract drifted underneath us and table storage must not
 * ship onto that box. Nothing here throws — callers read the report and decide
 * severity (CI fails the run; boot logs loudly; sanity shows fail).
 *
 * Probes are self-contained: each works in a throwaway temp directory and
 * cleans up after itself. No dependency on TABLE_DB_DIR existing — that is a
 * separate (P1) mount/writability check, deliberately not conflated with
 * engine capability.
 */

export type ProbeResult = {
  key: string;
  /** Did the behavior hold? */
  ok: boolean;
  /** Required probes gate table storage; informational ones only report. */
  required: boolean;
  detail: string;
};

export type ProbeReport = {
  /** True when every REQUIRED probe passed. */
  ok: boolean;
  results: ProbeResult[];
};

/**
 * Minimal structural type for the bits of node:sqlite we use (mirrors
 * app-broker.ts — keeps us compatible across @types/node versions that
 * pre-date the module).
 */
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};
type SqliteCtor = new (file: string, opts?: { readOnly?: boolean }) => SqliteDb;

/** Set alongside the ctor load; read by the backup_api_present probe. */
let moduleBackup: unknown;

function sqliteCtor(): SqliteCtor {
  // getBuiltinModule keeps vite/vitest from trying to bundle node:sqlite
  // (same pattern as app-broker).
  const mod = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: SqliteCtor;
    backup?: unknown;
  };
  moduleBackup = mod.backup;
  return mod.DatabaseSync;
}

type Probe = { key: string; required: boolean; run: (dir: string, Db: SqliteCtor) => string };

/** Each probe returns a pass detail string or throws with the drift found. */
const PROBES: Probe[] = [
  {
    // table_sql's safety floor: {readOnly:true} must reject writes at the
    // engine level, not by convention.
    key: 'readonly_blocks_writes',
    required: true,
    run: (dir, Db) => {
      const file = path.join(dir, 'ro.sqlite');
      const rw = new Db(file);
      rw.exec('CREATE TABLE t (x INTEGER)');
      rw.exec('INSERT INTO t VALUES (1)');
      rw.close();
      const ro = new Db(file, { readOnly: true });
      try {
        let blocked = false;
        try {
          ro.exec('INSERT INTO t VALUES (2)');
        } catch {
          blocked = true;
        }
        if (!blocked) throw new Error('write on a readOnly handle succeeded');
        const row = ro.prepare('SELECT count(*) AS n FROM t').get();
        if (Number(row?.n) !== 1) throw new Error(`read on readOnly handle returned ${String(row?.n)} rows, expected 1`);
        return 'readOnly handle rejects writes and serves reads';
      } finally {
        ro.close();
      }
    },
  },
  {
    // WAL is our concurrency model; it must survive close/reopen (it is a
    // persistent file property, but "persists" is exactly the kind of claim
    // an experimental module could drift on).
    key: 'wal_persists',
    required: true,
    run: (dir, Db) => {
      const file = path.join(dir, 'wal.sqlite');
      const a = new Db(file);
      a.exec('PRAGMA journal_mode = WAL');
      a.exec('CREATE TABLE t (x INTEGER)');
      a.close();
      const b = new Db(file);
      try {
        const mode = b.prepare('PRAGMA journal_mode').get();
        const val = String(mode?.journal_mode ?? '').toLowerCase();
        if (val !== 'wal') throw new Error(`journal_mode after reopen is '${val}', expected 'wal'`);
        return 'journal_mode=WAL persists across reopen';
      } finally {
        b.close();
      }
    },
  },
  {
    // The in-file fuzzy-search plan: FTS5 with the trigram tokenizer, and
    // LIKE '%…%' actually accelerated by it (VIRTUAL TABLE INDEX in the plan,
    // not a full scan).
    key: 'fts5_trigram_like',
    required: true,
    run: (dir, Db) => {
      const db = new Db(path.join(dir, 'fts.sqlite'));
      try {
        db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='trigram')");
        db.exec("INSERT INTO f (body) VALUES ('pressure vessel weld inspection'), ('rotating equipment vibration')");
        const hits = db.prepare("SELECT rowid FROM f WHERE body LIKE '%vessel weld%'").all();
        if (hits.length !== 1) throw new Error(`trigram LIKE returned ${hits.length} rows, expected 1`);
        const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM f WHERE body LIKE '%vessel weld%'").all();
        const planText = plan.map((r) => String(r.detail ?? '')).join(' | ');
        if (!/VIRTUAL TABLE INDEX/i.test(planText)) {
          throw new Error(`LIKE on the trigram table is not index-accelerated — plan: ${planText}`);
        }
        return 'FTS5 trigram tokenizer works; LIKE is trigram-accelerated';
      } finally {
        db.close();
      }
    },
  },
  {
    // The documented footgun the engine must handle: bare MATCH terms
    // containing '-' are FTS5 syntax errors; double-quoting fixes them. Pin
    // BOTH sides so a parser change (either direction) surfaces.
    key: 'fts5_match_hyphen_quoting',
    required: true,
    run: (dir, Db) => {
      const db = new Db(path.join(dir, 'match.sqlite'));
      try {
        db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='trigram')");
        db.exec("INSERT INTO f (body) VALUES ('unit K-101 compressor')");
        let unquotedThrew = false;
        try {
          db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('K-101');
        } catch {
          unquotedThrew = true;
        }
        if (!unquotedThrew) {
          throw new Error("bare MATCH 'K-101' no longer errors — quoting behavior changed, re-verify the term quoter");
        }
        const quoted = db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('"K-101"');
        if (quoted.length !== 1) throw new Error(`double-quoted MATCH returned ${quoted.length} rows, expected 1`);
        return "bare '-' terms error, double-quoted terms match (quoter contract holds)";
      } finally {
        db.close();
      }
    },
  },
  {
    // The backup primitive: VACUUM INTO must produce a complete, standalone
    // snapshot from a WAL database whose latest rows still live in the -wal.
    key: 'vacuum_into_wal_snapshot',
    required: true,
    run: (dir, Db) => {
      const src = path.join(dir, 'src.sqlite');
      const dest = path.join(dir, 'snap.sqlite');
      const db = new Db(src);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('CREATE TABLE t (x INTEGER)');
        db.exec('INSERT INTO t VALUES (1), (2)');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        // These rows live only in the WAL at snapshot time.
        db.exec('INSERT INTO t VALUES (3), (4)');
        db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
      const snap = new Db(dest, { readOnly: true });
      try {
        const row = snap.prepare('SELECT count(*) AS n FROM t').get();
        if (Number(row?.n) !== 4) throw new Error(`snapshot has ${String(row?.n)} rows, expected 4 (WAL rows missing)`);
        return 'VACUUM INTO under WAL captures un-checkpointed rows';
      } finally {
        snap.close();
      }
    },
  },
  {
    // Informational: sqlite.backup() (module-level, Node ≥23.8) is the
    // alternative snapshot primitive. We default to VACUUM INTO; this only
    // reports availability.
    key: 'backup_api_present',
    required: false,
    run: () => {
      if (typeof moduleBackup !== 'function') {
        throw new Error('sqlite.backup() not exported on this Node — VACUUM INTO remains the snapshot path');
      }
      return 'sqlite.backup() available (unused; VACUUM INTO is the default)';
    },
  },
];

/** Run every probe in an isolated temp dir. Never throws. */
export async function runTableStorageProbes(): Promise<ProbeReport> {
  let Db: SqliteCtor;
  try {
    Db = sqliteCtor();
  } catch (err) {
    return {
      ok: false,
      results: [
        {
          key: 'module_available',
          ok: false,
          required: true,
          detail: `node:sqlite failed to import — ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-probe-'));
  try {
    const results = PROBES.map((p): ProbeResult => {
      try {
        return { key: p.key, ok: true, required: p.required, detail: p.run(dir, Db) };
      } catch (err) {
        return {
          key: p.key,
          ok: false,
          required: p.required,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    });
    return { ok: results.every((r) => r.ok || !r.required), results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
