/**
 * Slider position to loudness (14.19–14.23).
 *
 * Its own module, free of any browser API, so the test suite can hold it. The curve is the part of
 * section 14 with a right answer and a silent failure mode: get it wrong and the control still
 * works, it is just unpleasant in a way nobody files a bug about.
 *
 * **A linear slider is the wrong control for loudness.** Perceived volume is roughly logarithmic,
 * so a linear one spends its top half in a range that all sounds much the same and then collapses
 * over the last few percent — which is why so many apps have an unusable 0–10% and a "quietest"
 * setting that is still too loud. This is a decibel position instead: equal movement, equal
 * change, all the way down (14.20, 14.21).
 *
 * **And zero is zero** (14.22). Not −60 dB, not a small number: off. "Off" and "very quiet" are
 * different things, and a control that cannot reach off is one people stop trusting.
 */

/** 14.23 — sixty decibels below unity, which is a whisper to a normal listening level. */
export const RANGE_DB = 60;

export function gainFor(position: number): number {
  const p = Math.min(1, Math.max(0, position));
  if (p === 0) return 0;
  return 10 ** ((p - 1) * (RANGE_DB / 20));
}

/** The decibels a position corresponds to, for showing beside the slider. */
export function decibelsFor(position: number): number {
  return (Math.min(1, Math.max(0, position)) - 1) * RANGE_DB;
}

export function labelFor(position: number): string {
  if (position <= 0) return "off";
  if (position >= 1) return "0 dB";
  return `${Math.round(decibelsFor(position))} dB`;
}
