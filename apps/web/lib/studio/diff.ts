/**
 * Minimal line-level diff for the Studio prose version history (no dependency).
 * LCS over lines → a sequence of equal / added / removed lines, rendered as a
 * git-style diff. Prompts are a few KB, so the O(n·m) DP is fine.
 */

export type DiffLine = { type: 'eq' | 'add' | 'del'; text: string };

export function lineDiff(aStr: string, bStr: string): DiffLine[] {
  const a = aStr.split('\n');
  const b = bStr.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! });
  while (j < m) out.push({ type: 'add', text: b[j++]! });
  return out;
}

/** True when the two strings differ once trailing whitespace per line is ignored. */
export function proseChanged(a: string, b: string): boolean {
  return a.trim() !== b.trim();
}
