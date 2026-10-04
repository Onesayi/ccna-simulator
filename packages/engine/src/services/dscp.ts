/** DSCP keywords IOS accepts and prints: default, EF, the assured forwarding classes and the class selectors. */
export const DSCP_VALUES: Record<string, number> = { default: 0, ef: 46 };
for (let c = 1; c <= 4; c++) for (let d = 1; d <= 3; d++) DSCP_VALUES[`af${c}${d}`] = 8 * c + 2 * d;
for (let c = 1; c <= 7; c++) DSCP_VALUES[`cs${c}`] = 8 * c;

/** `ef`, `af41`, `cs3` or a number from 0 to 63. */
export function parseDscp(word: string | undefined): number {
  const w = (word ?? '').toLowerCase();
  const n = DSCP_VALUES[w] ?? (/^\d+$/.test(w) ? Number(w) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > 63) throw new Error(`Invalid input detected at '^' marker.`);
  return n;
}

/** The keyword for a DSCP value (`ef`, `af41`), or the number when it has none. */
export function dscpName(n: number): string {
  return Object.entries(DSCP_VALUES).find(([, v]) => v === n)?.[0] ?? String(n);
}
