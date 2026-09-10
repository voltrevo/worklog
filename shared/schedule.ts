/**
 * What counts as a workday, and how long it is.
 *
 * The schedule is the primitive the whole of section 6 now rests on. Configuring *when* you work
 * rather than *how many hours* is what lets the projection move during the day (6.27), and it
 * collapses three earlier rules into one: a workday is a day with an interval (6.24), its expected
 * hours are that interval's length (6.25), and weekends are off because Saturday and Sunday are
 * empty by default (6.23) rather than because a rule says so.
 */

import type {
  DateString,
  DayInterval,
  Holiday,
  PacingOverride,
  Weekday,
  WeeklySchedule,
} from "./types.ts";
import { datesInMonth, minutesOf, weekdayOf } from "./dates.ts";

/** Monday to Friday, nine to five; Saturday and Sunday empty (6.23). */
export function defaultSchedule(): WeeklySchedule {
  const day: DayInterval = { start: "09:00", end: "17:00" };
  return { 1: day, 2: day, 3: day, 4: day, 5: day, 6: null, 7: null };
}

/** How the effective interval for one date was arrived at, so the UI can say why (6.18, 6.37). */
export interface DayShape {
  date: DateString;
  interval: DayInterval;
  hours: number;
  /** The holiday that emptied this day, if one did. */
  holiday?: Holiday;
  /** True when a pacing override decided this day rather than the schedule (6.19). */
  overridden: boolean;
}

export interface Calendar {
  schedule: WeeklySchedule;
  /** Keyed by date. Already filtered to the configured region and to real public holidays. */
  holidays: ReadonlyMap<DateString, Holiday>;
  /** Keyed by date (6.19, 6.20 — pacing only, never a billable record). */
  overrides: ReadonlyMap<DateString, PacingOverride>;
}

export function emptyCalendar(schedule: WeeklySchedule = defaultSchedule()): Calendar {
  return { schedule, holidays: new Map(), overrides: new Map() };
}

export function hoursIn(interval: DayInterval): number {
  if (!interval) return 0;
  return Math.max(0, minutesOf(interval.end) - minutesOf(interval.start)) / 60;
}

/**
 * The effective shape of one day.
 *
 * **An override outranks a holiday**, because that is the point of it: 6.19 gives the example of
 * intentional weekend work, and a holiday you have decided to work is the same case. A holiday with
 * no override empties the day whatever the schedule says.
 */
export function shapeOf(date: DateString, cal: Calendar): DayShape {
  const override = cal.overrides.get(date);
  if (override) {
    return {
      date,
      interval: override.interval,
      hours: hoursIn(override.interval),
      overridden: true,
    };
  }
  const holiday = cal.holidays.get(date);
  if (holiday) return { date, interval: null, hours: 0, holiday, overridden: false };

  const interval = cal.schedule[weekdayOf(date)];
  return { date, interval, hours: hoursIn(interval), overridden: false };
}

/** 6.24 — a day with a non-empty interval, once holidays and overrides have had their say. */
export function isWorkday(date: DateString, cal: Calendar): boolean {
  return shapeOf(date, cal).hours > 0;
}

/** Every day of the month, shaped. Callers filter; nothing here decides what is interesting. */
export function shapeMonth(month: string, cal: Calendar): DayShape[] {
  return datesInMonth(month).map((d) => shapeOf(d, cal));
}

export function workdaysIn(month: string, cal: Calendar): DayShape[] {
  return shapeMonth(month, cal).filter((d) => d.hours > 0);
}

/** 6.30 — the sum of scheduled hours across the month's workdays. */
export function capacityHours(month: string, cal: Calendar): number {
  return workdaysIn(month, cal).reduce((t, d) => t + d.hours, 0);
}

/** 6.17 — how much room the month has beyond the target. */
export function slackHours(
  month: string,
  cal: Calendar,
  monthlyTargetHours: number | null,
): number | null {
  // 27.31 — no target, no slack against it.
  if (monthlyTargetHours === null) return null;
  return capacityHours(month, cal) - monthlyTargetHours;
}

/** The holidays that shaped a month, for showing alongside the pacing figures (6.37). */
export function holidaysUsed(month: string, cal: Calendar): Holiday[] {
  return shapeMonth(month, cal).flatMap((d) => (d.holiday ? [d.holiday] : []));
}

/**
 * How much of a day's interval has not yet elapsed, given the local clock in minutes past midnight.
 *
 * Before the interval starts this is the whole of it; after it ends, zero. This is the only part of
 * the projection that moves on its own, and it is what makes 6.27 true.
 */
export function remainingHours(shape: DayShape, nowMinutes: number): number {
  if (!shape.interval) return 0;
  const end = minutesOf(shape.interval.end);
  const start = minutesOf(shape.interval.start);
  return Math.max(0, end - Math.max(start, nowMinutes)) / 60;
}

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
