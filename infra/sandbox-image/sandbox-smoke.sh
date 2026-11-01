#!/usr/bin/env bash
# sandbox-smoke: prove the sandbox kit works, online or with the network off.
#
# For every language it opens and queries one SQLite file, and for the
# compiled ones it makes a first build from the image's caches only:
#   sqlite3 CLI, duckdb CLI (sqlite + csv), node:sqlite, bun:sqlite,
#   python sqlite3 + sqlite-utils, Go (modernc.org/sqlite, gofmt, go vet,
#   staticcheck), Rust (rusqlite bundled, rustfmt, clippy), a wasm-pack build
#   of a wasm-bindgen crate, the Node kit (require, and ESM with no install),
#   the Python kit (every import), ruff, pytest, biome, vitest, tsc, esbuild.
# Every build here runs offline on purpose (cargo --offline, Go from the
# module-cache proxy, Node from the kit): a pass means a sandbox with no network can
# do the same.
#
# Usage: sandbox-smoke [-k] [-q]   (-k keeps the work dir, -q prints failures only)
# Exit 0 when every check passes, 1 otherwise. Writes only under a temp dir.

set -uo pipefail

KEEP=""; QUIET=""
for a in "$@"; do
  case "$a" in
    -k) KEEP=1 ;;
    -q) QUIET=1 ;;
    *) echo "usage: sandbox-smoke [-k] [-q]" >&2; exit 2 ;;
  esac
done

W=$(mktemp -d /tmp/sandbox-smoke.XXXXXX)
[ -n "$KEEP" ] || trap 'rm -rf "$W"' EXIT
DB="$W/smoke.db"
PASS=0; FAIL=0; FAILED=""

check() {
  local name=$1; shift
  local out
  if out=$("$@" 2>&1); then
    PASS=$((PASS + 1))
    [ -n "$QUIET" ] || printf 'ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1)); FAILED="$FAILED $name"
    printf 'FAIL  %s\n%s\n' "$name" "$(printf '%s\n' "$out" | tail -25 | sed 's/^/      /')"
  fi
}

# expect <want> <cmd...>: the command's trimmed output must be exactly <want>.
expect() {
  local want=$1; shift
  local got
  got=$("$@") || return 1
  got=$(printf '%s' "$got" | tr -d '\r' | sed -e 's/[[:space:]]*$//')
  [ "$got" = "$want" ] || { echo "want '$want', got '$got'"; return 1; }
}

net=offline
if curl -fsS -m 5 -o /dev/null https://registry.npmjs.org/ 2>/dev/null; then net=online; fi
[ -n "$QUIET" ] || echo "sandbox-smoke: network $net, work dir $W"

# ── the SQLite file every language reads ─────────────────────────────────────
sqlite3 "$DB" "CREATE TABLE parts(id INTEGER PRIMARY KEY, tag TEXT, qty INTEGER);
  INSERT INTO parts(tag, qty) VALUES ('P-101', 3), ('V-202', 4), ('E-303', 5);"
check "sqlite3 cli" expect 12 sqlite3 "$DB" "SELECT sum(qty) FROM parts"
printf 'tag,qty\nA,1\nB,2\n' > "$W/parts.csv"
check "duckdb cli (sqlite)" expect 12 duckdb -noheader -list -c "LOAD sqlite; SELECT sum(qty) FROM sqlite_scan('$DB', 'parts')"
check "duckdb cli (csv)" expect 3 duckdb -noheader -list -c "SELECT sum(qty) FROM read_csv('$W/parts.csv')"

# ── Node + Bun ───────────────────────────────────────────────────────────────
check "node:sqlite" expect 12 node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  console.log(db.prepare('SELECT sum(qty) AS n FROM parts').get().n);" "$DB"
check "bun:sqlite" expect 12 bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database(process.argv.at(-1), { readonly: true });
  console.log(db.query('SELECT sum(qty) AS n FROM parts').get().n);" "$DB"
check "node kit (require via NODE_PATH)" bash -c 'cd / && node -e "
  for (const m of [\"zod\", \"date-fns\", \"csv-parse/sync\", \"exceljs\", \"cheerio\", \"esbuild\", \"typescript\", \"jsonwebtoken\"]) require(m);
  const { z } = require(\"zod\"); z.string().parse(\"ok\");"'
check "bun kit (NODE_PATH)" bash -c 'cd / && bun -e "
  const { z } = require(\"zod\"); z.string().parse(\"ok\");
  const { format } = require(\"date-fns\"); format(new Date(0), \"yyyy\");"'
mkdir -p "$W/esm" && cd "$W/esm" && echo '{"name":"esm","private":true,"type":"module"}' > package.json
cat > "$W/esm/app.ts" <<'EOF'
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
const Row = z.object({ tag: z.string(), qty: z.coerce.number() });
const rows: unknown[] = parse('tag,qty\nA,1\nB,2\n', { columns: true });
console.log(rows.map((r) => Row.parse(r).qty).reduce((a, b) => a + b, 0));
EOF
check "node ESM import of the kit (no install)" expect ok bash -c "cd '$W/esm' && node --input-type=module -e \"import { z } from 'zod'; import { parse } from 'csv-parse/sync'; import ExcelJS from 'exceljs'; z.string().parse('x'); console.log('ok')\""
check "esbuild bundle + node (ESM)" bash -c "cd '$W/esm' && esbuild app.ts --bundle --platform=node --format=esm --outfile=out.mjs --log-level=warning && [ \"\$(node out.mjs)\" = 3 ]"
check "bun run ts" expect 3 bash -c "cd '$W/esm' && bun app.ts"
cat > "$W/esm/sum.ts" <<'EOF'
export const sum = (a: number, b: number): number => a + b;
EOF
cat > "$W/esm/sum.test.ts" <<'EOF'
import { expect, test } from 'vitest';
import { sum } from './sum';
test('sum', () => expect(sum(1, 2)).toBe(3));
EOF
check "tsc --noEmit" bash -c "cd '$W/esm' && tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck sum.ts"
check "biome check" bash -c "cd '$W/esm' && biome check --formatter-enabled=false sum.ts"
check "vitest" bash -c "cd '$W/esm' && vitest run --reporter=dot sum.test.ts"

# ── Python ───────────────────────────────────────────────────────────────────
check "python sqlite3 + sqlite-utils" expect 12 python3 -c "
import sqlite3, sys, sqlite_utils
db = sqlite_utils.Database(sqlite3.connect(sys.argv[1]))
print(sum(r['qty'] for r in db['parts'].rows))" "$DB"
check "python kit imports" python3 -c "
import requests, httpx, flask, fastapi, uvicorn, pandas, numpy, pydantic, yaml, dateutil
import openpyxl, xlsxwriter, docx, pypdf, pdfplumber, bs4, lxml, psycopg, sqlite_utils
import jinja2, matplotlib, plotly, scipy, pint, ezdxf, shapely, networkx
matplotlib.use('Agg')
import pandas as pd; assert int(pd.read_csv('$W/parts.csv')['qty'].sum()) == 3
print('ok')"
cat > "$W/test_smoke.py" <<'EOF'
def test_sum():
    assert sum([1, 2]) == 3
EOF
check "ruff" ruff check --no-cache "$W/test_smoke.py"
check "pytest" bash -c "cd '$W' && pytest -q -p no:cacheprovider test_smoke.py"

# ── Go ───────────────────────────────────────────────────────────────────────
mkdir -p "$W/go" && cd "$W/go"
cat > main.go <<'EOF'
package main

import (
	"database/sql"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	db, err := sql.Open("sqlite", os.Args[1])
	if err != nil {
		panic(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow("SELECT sum(qty) FROM parts").Scan(&n); err != nil {
		panic(err)
	}
	fmt.Println(n)
}
EOF
export GOCACHE="$W/go-build"
check "go mod init + tidy (module cache)" bash -c "go mod init smoke >/dev/null 2>&1 && go mod tidy"
check "go build + run (modernc.org/sqlite)" expect 12 bash -c "go build -o smoke . && ./smoke '$DB'"
check "gofmt" bash -c '[ -z "$(gofmt -l .)" ]'
check "go vet" go vet ./...
check "staticcheck" staticcheck ./...
# Online only: a module OUTSIDE the kit still resolves and is checked against
# the public checksum database (the module cache must not stand in for it).
if [ "$net" = online ]; then
  check "go get outside the kit (online, sumdb-checked)" go get github.com/google/btree@v1.1.3
fi

# ── Rust ─────────────────────────────────────────────────────────────────────
export CARGO_TARGET_DIR="$W/cargo-target"
mkdir -p "$W/rs/src" && cd "$W/rs"
cat > Cargo.toml <<'EOF'
[package]
name = "smoke"
version = "0.1.0"
edition = "2024"

[dependencies]
rusqlite = { version = "0.41", features = ["bundled"] }
EOF
cat > src/main.rs <<'EOF'
fn main() -> rusqlite::Result<()> {
    let path = std::env::args().nth(1).expect("db path");
    let db = rusqlite::Connection::open(path)?;
    let n: i64 = db.query_row("SELECT sum(qty) FROM parts", [], |r| r.get(0))?;
    println!("{n}");
    Ok(())
}
EOF
check "cargo build --offline + run (rusqlite bundled)" expect 12 bash -c "cargo build --offline -q && '$CARGO_TARGET_DIR/debug/smoke' '$DB'"
check "rustfmt" cargo fmt --check
check "clippy" cargo clippy --offline -q -- -D warnings

mkdir -p "$W/wasm/src" && cd "$W/wasm"
cat > Cargo.toml <<'EOF'
[package]
name = "smoke-wasm"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
EOF
cat > src/lib.rs <<'EOF'
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn total(qty: Vec<u32>) -> u32 {
    qty.iter().sum()
}
EOF
check "wasm-pack build, cargo offline (wasm32)" bash -c "CARGO_NET_OFFLINE=true wasm-pack build --target web --release --out-dir '$W/wasm-pkg' && test -s '$W/wasm-pkg/smoke_wasm_bg.wasm' && test -s '$W/wasm-pkg/smoke_wasm.js'"

# ── the manifest ─────────────────────────────────────────────────────────────
check "kit manifest" python3 -c "
import json; k = json.load(open('/etc/mantle/sandbox-kit.json'))
assert {'node', 'bun', 'python', 'go', 'rust'} <= set(k['languages']), k['languages'].keys()"

echo "sandbox-smoke: $PASS passed, $FAIL failed (network $net)${FAILED:+; failed:$FAILED}"
[ "$FAIL" -eq 0 ]
