// Deterministic PRNG (mulberry32) + helpers. Same seed → identical stream;
// the determinism test hashes two full runs and asserts byte equality.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),           // inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    pickN: (arr, n) => rng.shuffle(arr).slice(0, n),
    shuffle: (arr) => {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
    chance: (p) => next() < p,
    // Deterministic sub-stream so modules can't perturb each other's sequences
    // when one adds a draw: each content module forks its own named stream.
    fork: (label) => {
      let h = 2166136261;
      for (const c of label) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
      return makeRng((a ^ h) >>> 0);
    },
  };
  return rng;
}
