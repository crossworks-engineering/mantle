"""Write the sandbox kit manifest (JSON on stdout) from what is INSTALLED.

Runs at the end of the image build (Dockerfile) and lands in
/etc/mantle/sandbox-kit.json, so an agent can read what a sandbox has with one
`cat` instead of trying commands. Versions come from the tools themselves and
from the installed packages, never from a hand-kept list, so the manifest
cannot drift from the image. The library LISTS come from the kit files in
/opt/mantle-kit (requirements.in, package.json, go.mod, Cargo.toml).
"""

import json
import re
import subprocess
import tomllib
from importlib import metadata
from pathlib import Path

KIT = Path("/opt/mantle-kit")


def run(*cmd: str) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except FileNotFoundError:
        return ""
    return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr).strip() else ""


def ver(*cmd: str) -> str:
    """The first version-looking token of a tool's version line."""
    m = re.search(r"\d+\.\d+(\.\d+)?([-.+~][0-9A-Za-z.]+)?|\d+", run(*cmd))
    return m.group(0) if m else ""


def python_kit() -> dict:
    libs, tools = {}, {}
    for line in (KIT / "python/requirements.in").read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        name = re.split(r"[\[=<>]", line)[0]
        if name == "pip":
            continue
        v = metadata.version(name)
        (tools if name in ("ruff", "pytest") else libs)[name] = v
    return {"libraries": libs, "tools": tools}


def node_kit() -> dict:
    deps = json.loads((KIT / "node/package.json").read_text())["dependencies"]
    installed = {}
    for name in deps:
        pkg = KIT / "node/node_modules" / name / "package.json"
        installed[name] = json.loads(pkg.read_text())["version"]
    tool_names = ("@biomejs/biome", "vitest", "typescript", "esbuild", "pnpm", "@anthropic-ai/claude-code")
    return {
        "libraries": {k: v for k, v in installed.items() if k not in tool_names},
        "tools": {k: v for k, v in installed.items() if k in tool_names},
    }


def go_kit() -> dict:
    mod = (KIT / "go/go.mod").read_text()
    block = re.search(r"require \((.*?)\)", mod, re.S)
    libs = {}
    for line in (block.group(1) if block else "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and "// indirect" not in line:
            libs[parts[0]] = parts[1]
    return libs


def rust_kit() -> dict:
    manifest = tomllib.loads((KIT / "rust/Cargo.toml").read_text())
    lock = tomllib.loads((KIT / "rust/Cargo.lock").read_text())
    locked = {}
    for p in lock.get("package", []):
        locked.setdefault(p["name"], p["version"])
    return {name: locked.get(name, "") for name in manifest["dependencies"]}


def installed_targets() -> list:
    out = subprocess.run(["rustup", "target", "list", "--installed"], capture_output=True, text=True, check=False)
    return sorted(out.stdout.split())


manifest = {
    "schema": 1,
    "image": "titanwest/mantle-sandbox",
    "summary": (
        "Node 26, Bun, Python 3.12, Go and Rust (with the wasm32 target) are all installed, "
        "each with the kit below. Kit libraries are pre-installed (Python, Node) or in the "
        "package cache (Go, Rust), so first builds work with no network. Anything else "
        "installs on demand (a balanced sandbox reaches the package registries only)."
    ),
    "languages": {
        "node": {
            "version": ver("node", "-v"),
            "npm": ver("npm", "-v"),
            **node_kit(),
            "use": (
                "import and require() find every kit library from any project with no install "
                "(/node_modules links to the kit; a project's own node_modules comes first)."
            ),
        },
        "bun": {
            "version": ver("bun", "--version"),
            "use": "bun runs .ts directly; bun:sqlite and bun test are built in; the Node kit resolves as in Node.",
        },
        "python": {
            "version": ver("python3", "--version"),
            "venv": "/opt/venv (first on PATH; pip install works inside it)",
            **python_kit(),
        },
        "go": {
            "version": ver("go", "version"),
            "libraries": go_kit(),
            "tools": {"gofmt": "bundled", "go vet": "bundled", "staticcheck": run("staticcheck", "-version")},
            "use": (
                "GOPROXY lists the module cache first, so `go mod tidy` resolves the kit offline "
                "(and pins the kit's versions; ask for another version with `go get mod@vX.Y.Z`). "
                "GOTOOLCHAIN=local: no toolchain downloads."
            ),
        },
        "rust": {
            "version": ver("rustc", "-V"),
            "cargo": ver("cargo", "-V"),
            "targets": installed_targets(),
            "crates": rust_kit(),
            "tools": {
                "rustfmt": ver("rustfmt", "--version"),
                "clippy": ver("cargo", "clippy", "--version"),
                "wasm-pack": ver("wasm-pack", "--version"),
                "wasm-bindgen": ver("wasm-bindgen", "--version"),
                "wasm-opt": ver("wasm-opt", "--version"),
            },
            "use": (
                "Kit crates are fetched, not built. With no network set CARGO_NET_OFFLINE=true (every "
                "cargo call, wasm-pack's too, then resolves from the cache); a crate outside the kit "
                "needs the network."
            ),
        },
    },
    "sqlite": {
        "node": "node:sqlite (built in)",
        "bun": "bun:sqlite (built in)",
        "python": "sqlite3 (standard library) + sqlite-utils",
        "go": "modernc.org/sqlite (pure Go)",
        "rust": "rusqlite with the bundled feature",
        "cli": {"sqlite3": ver("sqlite3", "--version"), "duckdb": ver("duckdb", "--version")},
        "duckdb_extensions": ["sqlite", "excel"],
        "boundary": (
            "A sandbox works on a SQLite FILE inside it. It never reaches the brain's live app "
            "databases: copy one in with sandbox_import, or use the app database tools."
        ),
    },
    "tools": {
        "git": ver("git", "--version"),
        "docker": ver("docker", "--version") + " (CLI only, no daemon)",
        "claude": ver("claude", "--version"),
        "ripgrep": ver("rg", "--version"),
        "jq": ver("jq", "--version"),
        "cmake": ver("cmake", "--version"),
        "build-essential": ver("gcc", "--version"),
    },
    "smoke_test": "sandbox-smoke (proves SQLite and a first build in every language; works offline)",
}

print(json.dumps(manifest, indent=2, sort_keys=False))
