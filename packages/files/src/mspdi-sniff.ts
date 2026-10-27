/**
 * Microsoft Project MSPDI detection: the cheap, total sniffs of a file's head
 * that say whether an `.xml` upload is a Project plan. Pure string tests
 * over at most 8 KB, so the brain runs them itself (the auto-table pass
 * rules most XML out before reading the file); the plan itself is parsed
 * by the parser service (./mspdi.ts).
 */

/** MSPDI's namespace. Present on every genuine Project export. */
const MSPDI_NS = 'schemas.microsoft.com/project';

/**
 * Does this look like a Project export?
 *
 * `.xml` is a container, like `.zip` — most XML is not a plan, and a false
 * positive would push an unrelated document through a task-grid mapper. So two
 * signals are required: a root element named `Project`, **and** either the MSPDI
 * namespace or a `<Tasks>` element. A bare `<Project>` root is not unique to
 * Microsoft.
 *
 * Cheap and total: reads the head of the file only, and never throws.
 */
export function sniffMspdi(head: Buffer | string): boolean {
  try {
    const s = text(head);
    if (!ROOT_RE.test(s)) return false;
    return s.includes(MSPDI_NS) || TASKS_RE.test(s);
  } catch {
    return false;
  }
}

/**
 * Is the root element `Project`? A **decisive negative** — cheap to answer from
 * the first few hundred bytes, and a document whose root is not `Project` cannot
 * be MSPDI no matter what follows.
 *
 * Exists so a caller can rule a file out before paying to read it. The full
 * {@link sniffMspdi} cannot be used that way: its second signal is the MSPDI
 * namespace OR a `<Tasks>` element, and while the namespace sits on the root,
 * `<Tasks>` does not — in a real 25 MB export it appeared at byte 114,966.
 * Sniffing a head would therefore answer *false* for a namespace-less plan with
 * a long header, and the file would be skipped rather than parsed. A negative
 * here is safe to act on; a positive means "read the file and ask properly".
 */
export function mspdiRootPresent(head: Buffer | string): boolean {
  try {
    return ROOT_RE.test(text(head));
  } catch {
    return false;
  }
}

const ROOT_RE = /<([A-Za-z_][\w.-]*:)?Project(\s|>|\/)/;
const TASKS_RE = /<([A-Za-z_][\w.-]*:)?Tasks(\s|>)/;

/** Bounded decode — never walks past the head, whatever the caller passes. */
function text(head: Buffer | string): string {
  return (typeof head === 'string' ? head : head.subarray(0, 8192).toString('utf8')).slice(0, 8192);
}
