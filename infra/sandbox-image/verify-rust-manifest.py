"""Prove the Rust toolchain rustup installed is the pinned release, byte for byte.

rustup checks every component tarball against the hashes in the release
manifest it downloads; that manifest itself comes over TLS, unpinned. The
Dockerfile downloads the same manifest and checks it against a pinned sha256;
this script then checks that every component rustup installed carries exactly
the hashes of that pinned manifest (rustup keeps its copy of the manifest
beside the toolchain). So no component can come from any other release.

Usage: verify-rust-manifest.py <pinned channel toml> <toolchain lib/rustlib dir>
"""

import sys
import tomllib
from pathlib import Path

pinned = tomllib.loads(Path(sys.argv[1]).read_text())
rustlib = Path(sys.argv[2])
stored = tomllib.loads((rustlib / "multirust-channel-manifest.toml").read_text())
installed = (rustlib / "components").read_text().split()

problems = []
if stored.get("date") != pinned.get("date"):
    problems.append(f"manifest date {stored.get('date')} != pinned {pinned.get('date')}")

matched = set()
for pkg, entry in pinned["pkg"].items():
    for target, build in entry.get("target", {}).items():
        name = f"{pkg}-{target}" if target != "*" else pkg
        if name not in installed:
            continue
        got = stored["pkg"].get(pkg, {}).get("target", {}).get(target, {})
        # Every hash either side carries (hash, xz_hash, zst_hash, any later
        # one): a stored manifest may not add a tarball the pinned one lacks.
        for key in sorted(k for k in set(build) | set(got) if k.endswith("hash")):
            if got.get(key) != build.get(key):
                problems.append(f"{name}: {key} {got.get(key)} != pinned {build.get(key)}")
        matched.add(name)

for name in installed:
    if name not in matched:
        problems.append(f"{name}: installed but not in the pinned manifest")

if problems:
    print("Rust toolchain does not match the pinned manifest:", *problems, sep="\n  ", file=sys.stderr)
    sys.exit(1)
print(f"rust toolchain: {len(matched)} components match the pinned {pinned.get('date')} manifest")
