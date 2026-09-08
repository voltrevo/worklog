/**
 * Calendar arithmetic on plain dates.
 *
 * Everything here is a pure function of `DateString`s. `Temporal` does the hard parts; this module
 * exists to name the operations the product actually asks for, and to keep `Temporal` from leaking
 * into the rest of the code as a second date type.
 *
 * **Only two functions know what time it is**, `today()` and `minutesSinceMidnight()`, and both read
 * the *viewing* device's clock (3.9, 6.38). Everything else takes the answer as an argument, which
 * is what makes a projection testable without pretending to be a Tuesday in March.
 */

import type { DateString, TimeString, Weekday } from "./types.ts";

/** The current date on this device (3.9). Different devices may disagree, which 3.10 accepts. */
export function today(): DateString {
  return Temporal.Now.plainDateISO().toString();
}

/** Minutes elapsed today on this device's clock, for measuring against a schedule interval. */
export function minutesSinceMidnight(): number {
  const t = Temporal.Now.plainTimeISO();
  return t.hour * 60 + t.minute + t.second / 60;
}

/** `2026-09` — the calendar month a date falls in, with no timezone involved (7.10). */
export function monthOf(date: DateString): string {
  return date.slice(0, 7);
}

export function weekdayOf(date: DateString): Weekday {
  return Temporal.PlainDate.from(date).dayOfWeek as Weekday;
}

export function addDays(date: DateString, days: number): DateString {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** Every date in `2026-09`, in order. */
export function datesInMonth(month: string): DateString[] {
  const first = Temporal.PlainDate.from(`${month}-01`);
  const out: DateString[] = [];
  for (let i = 0; i < first.daysInMonth; i++) out.push(first.add({ days: i }).toString());
  return out;
}

/** Whether `date` falls in `month`, the half-open range being implied by the string prefix. */
export function inMonth(date: DateString, month: string): boolean {
  return monthOf(date) === month;
}

/** `-1` if a is earlier, `0` if equal, `1` if later. Lexicographic order is date order here. */
export function compare(a: DateString, b: DateString): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minutes from midnight to `HH:MM`. */
export function minutesOf(time: TimeString): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * The date `weeks` weeks after `date`, then rolled forward to Monday unless it is already Monday.
 *
 * This is the invoice due-date rule (10.2, 10.3, 10.4), which lives here rather than in `invoice.ts`
 * because it is calendar arithmetic and it is the one piece of that rule worth testing on its own.
 */
export function weeksThenMonday(date: DateString, weeks: number): DateString {
  const d = Temporal.PlainDate.from(date).add({ weeks });
  const forward = (8 - d.dayOfWeek) % 7; // 0 when already Monday (10.3)
  return d.add({ days: forward }).toString();
}

/** `2026-09` for the month containing `date`, and the months before and after it. */
export function shiftMonth(month: string, by: number): string {
  return Temporal.PlainYearMonth.from(month).add({ months: by }).toString();
}

/** Whether `a` is a strictly earlier month than `b`. Both are `YYYY-MM`. */
export function monthBefore(a: string, b: string): boolean {
  return a < b;
}
