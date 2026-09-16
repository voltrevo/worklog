/**
 * The fixture's decisions about *today*, apart from the seeder that writes them.
 *
 * `tools/seed.ts` runs on import — it opens a database and fills it — so nothing can test the rules
 * inside it without also performing them. These two are the rules the screens depend on, and they
 * are the ones that were getting decided by chance.
 *
 * **The end-to-end suite passed or failed by the date it was run on.** The timer screen draws
 * today's total against today's scheduled hours, and `progress` caps at 1, so a day already at or
 * past its schedule paints a full bar — the same picture whatever the figures beneath it say.
 * `tools/journey.mjs`'s 26.19 check knows that and skips a saturated reading rather than passing on
 * one, which is right; what it cannot do is measure when every reading is saturated.
 *
 * Both routes to that happened to be open:
 *
 * - **The hours.** A weekday drew `5 + random() * 4`, five to nine hours against an eight hour
 *   schedule, and `fill(thisMonth, today())` consumes a draw per day before reaching today — so
 *   which side of eight today landed on was a function of the calendar date. Measured on
 *   2026-09-16: 8.75h, four saturated readings, `0 usable readings`, red. On 2026-09-08, when the
 *   seed constant was chosen, it came out under and the suite was green.
 * - **The week.** Mon–Fri leaves Saturday and Sunday with no scheduled interval, so the bar's
 *   denominator is zero, every reading is skipped for `ofH === 0` instead, and the check fails
 *   having measured nothing — two days in seven, with the product working.
 *
 * Neither is a product fault and neither would have been found by reading the product. They are
 * the fixture failing to hold a property the things that consume it assume.
 */

import type { DayInterval, Weekday } from "../shared/types.ts";

/** The interval a scheduled day gets in this fixture. */
export const NINE_TO_FIVE = { start: "09:00", end: "17:00" } as const;

/**
 * Hours of headroom today must keep under its own schedule.
 *
 * 26.19 starts and stops the timer four times before it reads the bar, so a margin measured in
 * seconds would be closed by the very check that depends on it — a check that passes until the day
 * it matters. An hour is far more than four short sessions and far less than a working day.
 */
export const TODAY_HEADROOM_HOURS = 1.5;

/**
 * Mon–Fri, plus today whichever day today is.
 *
 * The second clause is the fixture admitting what it is for: today's scheduled interval is the
 * denominator of the screen this database exists to drive. Somebody who works a Saturday is a
 * person this product is for, so a fixture whose week includes one is not an invented default of
 * the kind 27.33 rules out — it is this seeded person's week, stated rather than assumed.
 */
export function fixtureSchedule(todayWeekday: Weekday): Record<Weekday, DayInterval> {
  const schedule: Record<Weekday, DayInterval> = {
    1: { ...NINE_TO_FIVE },
    2: { ...NINE_TO_FIVE },
    3: { ...NINE_TO_FIVE },
    4: { ...NINE_TO_FIVE },
    5: { ...NINE_TO_FIVE },
    6: null,
    7: null,
  };
  schedule[todayWeekday] = { ...NINE_TO_FIVE };
  return schedule;
}

/** The hours a schedule gives a weekday, and 0 for one it does not schedule. */
export function scheduledHours(
  schedule: Record<Weekday, DayInterval>,
  weekday: Weekday,
): number {
  const day = schedule[weekday];
  if (!day) return 0;
  const mins = (t: string) => {
    const [h, m] = t.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };
  return (mins(day.end) - mins(day.start)) / 60;
}

/**
 * The hours to record on a day, in quarters — capped on today so the bar is never already full.
 *
 * Capped rather than fixed, so the day still varies from month to month; the only invariant is
 * that there is work left to do on it. A day that is not today is left entirely to the draw,
 * because the variety is what makes the pacing screen worth photographing.
 */
export function hoursFor(
  raw: number,
  isToday: boolean,
  scheduled: number,
): number {
  const capped = isToday && scheduled > 0 ? Math.min(raw, scheduled - TODAY_HEADROOM_HOURS) : raw;
  return Math.round(capped * 4) / 4;
}
