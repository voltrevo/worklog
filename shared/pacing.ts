/**
 * Am I on track this month?
 *
 * The whole projection is one sum over the month's days, and every day contributes the same two
 * things: **work already recorded on it, plus however much of its scheduled interval has not yet
 * elapsed.** A past day has no interval left, so it contributes only what was worked. A future day
 * has all of it. Today has the part after the current minute — which is the only term that moves,
 * and why the figure changes through the day (6.27) rather than stepping at midnight.
 *
 * Writing it as one uniform rule rather than the three cases of 6.29 is not a liberty: past, today
 * and future fall out of "how much of this day's interval is left", and viewing last month or next
 * month then needs no special case either.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * - **You fall behind in real time.** Sitting idle through a scheduled morning lowers the
 *   projection as the morning passes. The superseded 6.10 did not do this; it assumed the full day
 *   regardless and only moved at midnight.
 * - **Early or extra work reads as ahead** (6.28). Work at 7am is added to a still-full interval
 *   rather than absorbed into it. The alternative — crediting only the larger of the two — hides
 *   real work, and this is a projection rather than an audit.
 */

import type { DateString, Holiday, WorkEntry } from "./types.ts";
import { type Calendar, holidaysUsed, remainingHours, shapeMonth } from "./schedule.ts";
import { capacityHours } from "./schedule.ts";

const MS_PER_HOUR = 3_600_000;

export interface PacingInput {
  month: string;
  cal: Calendar;
  monthlyTargetHours: number;
  /** Every entry; entries outside `month` are ignored rather than an error. */
  entries: readonly WorkEntry[];
  /** The viewing device's today (3.9). May be outside `month`, and usually is. */
  today: DateString;
  /** Minutes past midnight on the viewing device (6.38). */
  nowMinutes: number;
}

export interface DayPacing {
  date: DateString;
  /** Hours recorded against this date. */
  actual: number;
  /**
   * The length of this day's scheduled interval, whatever the clock has done to it.
   *
   * Reported rather than left to be reconstructed: `actual + remaining` is this day's
   * *contribution to the projection*, not its length, and the home screen briefly showed a
   * nine-to-five Tuesday as "11h 23m scheduled" because the two look alike at a glance.
   */
  scheduled: number;
  /** Hours of this date's interval still ahead of `now`. */
  remaining: number;
  /** What this day contributes to the projection: `actual + remaining`. */
  contribution: number;
  holiday?: Holiday;
}

export interface Pacing {
  month: string;
  /** 7.2 — what has actually been worked in this month, whatever the clock says. */
  workedHours: number;
  /** 6.13's first term, kept because the pacing detail shows it. */
  actualBeforeToday: number;
  actualToday: number;
  /** The part of today's interval still ahead. Zero when today is not in this month. */
  remainingToday: number;
  /** 6.26 — `actualToday + remainingToday`. */
  todayContribution: number;
  /** The scheduled hours of every workday after today in this month. */
  remainingWorkdayHours: number;
  /**
   * Hours already recorded against dates *after* today — a duration-only entry filed forward.
   *
   * 6.29's three terms do not mention this, because a future-dated entry was not contemplated. It
   * is a real thing the UI allows, so it is a fourth term rather than something quietly folded into
   * `remainingWorkdayHours`: that field means "scheduled hours still to come", and adding recorded
   * work to it would make the pacing detail's own arithmetic stop adding up.
   */
  actualAfterToday: number;
  /** 6.29 */
  projectedHours: number;
  monthlyTargetHours: number;
  /** 6.14, 6.15 — positive is ahead, negative is behind. */
  paceHours: number;
  /** 6.30 */
  capacityHours: number;
  /** 6.17 */
  slackHours: number;
  /** 6.37 — which holidays shaped this month. */
  holidays: Holiday[];
  days: DayPacing[];
}

/** Hours per date, from the durations rather than from the timings (2.13, 7.3). */
export function actualByDate(entries: readonly WorkEntry[]): Map<DateString, number> {
  const out = new Map<DateString, number>();
  for (const e of entries) {
    out.set(e.date, (out.get(e.date) ?? 0) + e.durationMs / MS_PER_HOUR);
  }
  return out;
}

export function project(input: PacingInput): Pacing {
  const { month, cal, monthlyTargetHours, entries, today, nowMinutes } = input;
  const actual = actualByDate(entries);

  const days: DayPacing[] = shapeMonth(month, cal).map((shape) => {
    const worked = actual.get(shape.date) ?? 0;
    // The one rule, in three lines. Past days have nothing left; future days have all of it.
    const remaining = shape.date < today
      ? 0
      : shape.date === today
      ? remainingHours(shape, nowMinutes)
      : shape.hours;
    return {
      date: shape.date,
      actual: worked,
      scheduled: shape.hours,
      remaining,
      contribution: worked + remaining,
      ...(shape.holiday ? { holiday: shape.holiday } : {}),
    };
  });

  const sum = (pick: (d: DayPacing) => number) => days.reduce((t, d) => t + pick(d), 0);

  const workedHours = sum((d) => d.actual);
  const actualBeforeToday = sum((d) => (d.date < today ? d.actual : 0));
  const actualToday = sum((d) => (d.date === today ? d.actual : 0));
  const remainingToday = sum((d) => (d.date === today ? d.remaining : 0));
  const remainingWorkdayHours = sum((d) => (d.date > today ? d.remaining : 0));
  const actualAfterToday = sum((d) => (d.date > today ? d.actual : 0));
  const projectedHours = sum((d) => d.contribution);
  const capacity = capacityHours(month, cal);

  return {
    month,
    workedHours,
    actualBeforeToday,
    actualToday,
    remainingToday,
    todayContribution: actualToday + remainingToday,
    remainingWorkdayHours,
    actualAfterToday,
    projectedHours,
    monthlyTargetHours,
    paceHours: projectedHours - monthlyTargetHours,
    capacityHours: capacity,
    slackHours: capacity - monthlyTargetHours,
    holidays: holidaysUsed(month, cal),
    days,
  };
}

/**
 * Today's live total, which is the home screen's primary metric (3.1, 3.4).
 *
 * Separate from the projection on purpose: this is what has happened, the projection is what is
 * expected to happen, and 3.8 puts them side by side. Conflating them is what made the old pace
 * figure sit still all day.
 */
export function workedToday(
  entries: readonly WorkEntry[],
  today: DateString,
  activeSinceMs = 0,
): number {
  const recorded = entries
    .filter((e) => e.date === today)
    .reduce((t, e) => t + e.durationMs, 0);
  return recorded + activeSinceMs;
}
