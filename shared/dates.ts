/**
 * Calendar arithmetic on plain dates.
 *
 * Everything here is a pure function of `DateString`s. This module exists to name the operations
 * the product actually asks for, and to keep any date *type* from leaking into the rest of the code
 * as a second way to say "the 8th of September".
 *
 * **Only two functions know what time it is**, `today()` and `minutesSinceMidnight()`, and both read
 * the *viewing* device's clock (3.9, 6.38). Everything else takes the answer as an argument, which
 * is what makes a projection testable without pretending to be a Tuesday in March.
 *
 * ## Why not `Temporal`
 *
 * It was `Temporal`, and `Temporal` is the right tool: seven calls did all of the work below in one
 * line each. It is also, as of this writing, **Chromium-only**. The desktop window is WebKitGTK and
 * throws `ReferenceError: Can't find variable: Temporal` on the first render — the whole app, a
 * blank window — and Safari and Firefox would have done the same to the GitHub Pages build. The
 * frontend worked in exactly one engine and the only test driving a browser used that engine.
 *
 * The alternative to this file was a polyfill, which is a couple of hundred kilobytes for seven
 * calls. What made a rewrite cheap was the containment the old header claimed: `Temporal` genuinely
 * had not leaked, so this is the only file that changed.
 *
 * **The dates are handled as UTC instants throughout.** A `DateString` names a day and nothing
 * else, so anchoring it to noon or midnight anywhere with a DST rule invites the day to shift under
 * arithmetic. `Date.UTC` has no such rule, and every function here converts back to `YYYY-MM-DD`
 * before returning, so the choice never escapes.
 */

import type { DateString, TimeString, Weekday } from "./types.ts";

/** `YYYY-MM-DD` to the UTC instant at its midnight. */
function utc(date: DateString): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** Back again. `toISOString` is UTC, so this is exact and needs no padding of its own. */
function iso(at: Date): DateString {
  return at.toISOString().slice(0, 10);
}

/** The current date on this device (3.9). Different devices may disagree, which 3.10 accepts. */
export function today(): DateString {
  // The *local* calendar date, which is the point (2.19): `toISOString` would give UTC's date and
  // put a Sydney evening on the wrong day.
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return iso(local);
}

/** Minutes elapsed today on this device's clock, for measuring against a schedule interval. */
export function minutesSinceMidnight(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

/** `2026-09` — the calendar month a date falls in, with no timezone involved (7.10). */
export function monthOf(date: DateString): string {
  return date.slice(0, 7);
}

export function weekdayOf(date: DateString): Weekday {
  // ISO numbering: Monday is 1 and Sunday is 7, where `getUTCDay` makes Sunday 0.
  return ((utc(date).getUTCDay() + 6) % 7 + 1) as Weekday;
}

export function addDays(date: DateString, days: number): DateString {
  const at = utc(date);
  at.setUTCDate(at.getUTCDate() + days);
  return iso(at);
}

/** Every date in `2026-09`, in order. */
export function datesInMonth(month: string): DateString[] {
  const out: DateString[] = [];
  // Walk until the month changes rather than computing a length: day 0 of the next month is the
  // usual trick and it is one off-by-one away from silently dropping the 31st.
  for (let day = 1;; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}` as DateString;
    if (monthOf(iso(utc(date))) !== month) return out;
    out.push(date);
  }
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
  const shifted = addDays(date, weeks * 7);
  const forward = (8 - weekdayOf(shifted)) % 7; // 0 when already Monday (10.3)
  return addDays(shifted, forward);
}

/** `2026-09` for the month containing `date`, and the months before and after it. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  // Month 0 and month 13 are what `Date.UTC` normalises for us, so December and January need no
  // special case and neither does a `by` of any size.
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return iso(at).slice(0, 7);
}

/** Whether `a` is a strictly earlier month than `b`. Both are `YYYY-MM`. */
export function monthBefore(a: string, b: string): boolean {
  return a < b;
}

/**
 * 27.21 — the one way a date is written, everywhere: `08 Sep 2026`.
 *
 * The app formatted dates through `Intl` in the *viewing device's* locale, so the same entry read
 * `08/09/2026` on one machine and `Sep 8` on another, and the invoice had a third spelling of its
 * own. A date on a document two people are looking at should not depend on which of them is
 * looking, and `08/09/2026` is ambiguous to half the world besides.
 *
 * Two digits for the day, because a column of dates that jumps between one and two characters is
 * harder to scan than one that does not; three letters for the month, because "Sept" is four and
 * the point is a fixed width.
 */
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatDay(date: DateString): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${String(d).padStart(2, "0")} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** The month a period names, spelled the same way: `Sep 2026`. */
export function formatMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Just the month's short name, for a caller assembling something else. */
export function monthShortName(month1To12: number): string {
  return MONTH_NAMES[month1To12 - 1] ?? "";
}
