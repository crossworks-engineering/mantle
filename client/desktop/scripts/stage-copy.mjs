/**
 * Recursive copy that PRESERVES symlinks, creating directory links as Windows
 * junctions so the copy works without elevation.
 *
 * Background: the desktop build failed on windows-latest for five releases at
 * the staging step —
 *
 *   cp: cannot create symbolic link '…/ui/./client/web/node_modules/next'
 *
 * because a true symlink on Windows needs Developer Mode or an elevated shell.
 *
 * The tempting fix — dereference the links — is WRONG, and quietly so. Next's
 * standalone tree is a pnpm layout: `next` physically lives at
 * `node_modules/.pnpm/next@<hash>/node_modules/next`, with its peers
 * (`@swc/helpers`, `react`, `styled-jsx`, …) as siblings in that same
 * directory, and `client/web/node_modules/next` is a link to it. Node resolves
 * a dependency by walking UP from the requiring file, so `next` has to sit
 * inside `.pnpm/next@<hash>/node_modules/` for its peers to be found.
 * Dereferencing copies `next`'s contents to a location whose parent has no
 * peers, and the staged server dies on boot with:
 *
 *   Error: Cannot find module '@swc/helpers/_/_interop_require_default'
 *
 * A `du -sh` and a symlink count both look fine at that point, which is exactly
 * why the check that matters is booting the staged server, not inspecting it.
 *
 * So: preserve the structure, and make each DIRECTORY link a junction —
 * `fs.symlinkSync(target, path, 'junction')` needs no privileges on Windows and
 * degrades to an ordinary symlink on POSIX. Junctions require an absolute
 * target, so the link's relative target is resolved against its destination,
 * keeping every link pointing inside the staged tree.
 *
 * Dangling links are skipped and reported: the standalone tree contains one
 * (`node_modules/.pnpm/node_modules/semver`), and both `cp -RL` and `tar -ch`
 * mishandle it — `cp` prints an error and still exits 0, so under `set -e` the
 * failure looks like success.
 */
import fs from 'node:fs';
import path from 'node:path';

const skipped = [];
/** Links are created in a SECOND pass. A junction whose target directory has
 *  not been copied yet may fail on Windows, and readdir order gives no
 *  guarantee the target comes first. */
const pending = [];

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      let targetIsDir;
      try {
        // Follows the link; throws when it dangles.
        targetIsDir = fs.statSync(from).isDirectory();
      } catch {
        skipped.push(path.relative(process.cwd(), from));
        continue;
      }
      // Resolve the link's target against the DESTINATION so it keeps pointing
      // inside the staged tree rather than back at the build checkout.
      pending.push({ to, absTarget: path.resolve(path.dirname(to), target), targetIsDir });
      continue;
    }

    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    // Sockets/FIFOs cannot appear in a build output; ignored deliberately.
  }
}

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: stage-copy.mjs <src> <dest>');
  process.exit(1);
}
copyTree(path.resolve(src), path.resolve(dest));

for (const { to, absTarget, targetIsDir } of pending) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.symlinkSync(absTarget, to, targetIsDir ? 'junction' : 'file');
}

if (skipped.length > 0) {
  console.warn(`  (skipped ${skipped.length} dangling symlink(s): ${skipped.join(', ')})`);
}
if (pending.length > 0) console.log(`  (linked ${pending.length} path(s); dirs as junctions)`);
