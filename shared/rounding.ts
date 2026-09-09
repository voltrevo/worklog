/**
 * Hours, to a tenth, rounded half-to-even (25.6, 25.7).
 *
 * **Why a tenth and not minutes.** An invoice line is `hours × rate`, and the hours column is
 * printed to one decimal place. If the arithmetic uses the unrounded figure, the document does not
 * add up: three lines printed as `2.5`, `2.5`, `2.5` at $120 come to `$900.00` on the page and
 * `$901.20` in the total, and the client is right to ask. So the rounded value is the official one
 * (25.7) and everything downstream is computed from it. The cost is up to three minutes a line,
 * which the requirement accepts explicitly.
 *
 * **Why half-to-even.** Half-up is biased: over a year of lines that land on a boundary, every one
 * of them rounds the same way and the total drifts in the invoicer's favour. Half-to-even splits
 * them, which is the whole reason accountants use it. It is worth being deliberate about here
 * because this is the number somebody gets paid on.
 *
 * The live running clock is exempt (25.6) — seconds are the point there, and a figure that jumps
 * between `2.5` and `2.6` while you watch is not a clock.
 */

/** A tenth of an hour, in milliseconds: the unit the boundary is measured in. */
const MS_PER_TENTH = 360_000;

/**
 * Milliseconds to hours, to one decimal place, half-to-even.
 *
 * Kept on integer milliseconds rather than dividing first, because the half-way case is exactly
 * what this function exists to decide and `ms / 3_600_000` throws away the ability to recognise
 * it: `0.05 * 10` is not reliably `0.5` once the input has been through a float, so a value three
 * minutes past the mark could take either branch depending on the arithmetic that produced it.
 * `ms % 360_000 === 180_000` is exact for every duration this app can hold.
 */
export function hoursOf(ms: number): number {
  const sign = ms < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(ms));
  const tenths = Math.floor(abs / MS_PER_TENTH);
  const rest = abs - tenths * MS_PER_TENTH;

  let out: number;
  if (rest > MS_PER_TENTH / 2) out = tenths + 1;
  else if (rest < MS_PER_TENTH / 2) out = tenths;
  // Dead on the boundary: to the even tenth. 0.25h → 0.2, 0.35h → 0.4.
  else out = tenths % 2 === 0 ? tenths : tenths + 1;

  return (sign * out) / 10;
}

/**
 * The same, for a figure that is already in hours.
 *
 * Pacing works in hours rather than milliseconds, so its numbers arrive here as floats. Going back
 * through milliseconds is not a detour — it is what puts both paths on the one rule, so a day that
 * reads `7.5` on the pacing screen reads `7.5` on the invoice too.
 */
export function roundHours(value: number): number {
  return hoursOf(value * 3_600_000);
}
