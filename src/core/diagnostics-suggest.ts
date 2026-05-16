/**
 * "Did you mean ...?" suggestion helper for validator findings.
 *
 * We want operators editing a config to see typo-style fixes inline:
 *
 *   call orphan_handler
 *           ^^^^^^^^^^^^^^
 *   undefined ruleset (did you mean: `orphan_handlers`?)
 *
 * Strategy: damerau-levenshtein-style edit distance, scoring candidates
 * by similarity to the misspelled token. We only suggest when the best
 * candidate is "close enough" (≤2 edits for short strings, scaled for
 * longer ones) — better to say nothing than to suggest a wrong fix.
 *
 * Pure function, no IO. Lives in the core module so the CLI, API, and
 * worker all reuse it.
 */

/** Smallest edit distance between two strings, treating transpositions as 1. */
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  // Classic 2D DP. The matrix is (la+1) × (lb+1).
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      // Transposition: swapping two adjacent characters is one edit, not
      // two — matters a lot for human typos ("sshd" vs "ssdh").
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

/**
 * Return the best "did you mean" candidate from `pool` for `needle`, or
 * null when nothing in the pool is close enough. The threshold scales
 * with the needle's length so short names need exact-ish matches and
 * long names tolerate one or two more typos.
 */
export function suggest(needle: string, pool: Iterable<string>): string | null {
  if (!needle) return null;
  // Threshold heuristic: 1 edit for ≤3 chars, 2 for ≤7, 3 thereafter,
  // capped at ~30% of the needle length so a 30-char identifier doesn't
  // accept a 10-edit suggestion.
  const len = needle.length;
  const maxEdits = Math.min(
    len <= 3 ? 1 : len <= 7 ? 2 : 3,
    Math.max(1, Math.floor(len * 0.4))
  );
  let best: string | null = null;
  let bestScore = Infinity;
  const lcNeedle = needle.toLowerCase();
  for (const candidate of pool) {
    if (candidate === needle) continue; // duplicate; suggesting itself is noise
    const score = damerauLevenshtein(lcNeedle, candidate.toLowerCase());
    if (score < bestScore && score <= maxEdits) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Append a " (did you mean: `X`?)" hint to a diagnostic message. */
export function withSuggestion(message: string, suggested: string | null): string {
  if (!suggested) return message;
  return `${message} (did you mean: \`${suggested}\`?)`;
}
