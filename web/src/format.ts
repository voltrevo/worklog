/**
 * Turning numbers into the words this app uses for them.
 *
 * One module so the same duration reads the same way on every screen — `3h 14m` in the header and
 * on the invoice and in the history, rather than three near-misses.
 */

import type { DateString } from "@worklog/shared/types";

/** `3h 14m`, and `14m` when there are no hours. Never `0h 14m`. */
export function duration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** `1:27:16` — for the running session, where the seconds are the point. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function hours(value: number): string {
  return duration(value * 3_600_000);
}

/** `+4h 0m ahead` / `2h 30m behind`, because a bare signed number is not an answer. */
export function pace(
  hoursValue: number,
): { text: string; tone: "good" | "bad" | "flat" } {
  const rounded = Math.round(hoursValue * 60) / 60;
  if (Math.abs(rounded) < 1 / 60) {
    return { text: "exactly on target", tone: "flat" };
  }
  return rounded > 0
    ? { text: `${hours(rounded)} ahead`, tone: "good" }
    : { text: `${hours(-rounded)} behind`, tone: "bad" };
}

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency })
      .format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const DAY_MONTH = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * A plain date, rendered without ever becoming an instant.
 *
 * `new Date("2026-09-08")` parses as UTC midnight and then formats in the local zone, which shows
 * the 7th to anyone west of Greenwich. Splitting the parts and using the local constructor keeps a
 * calendar date a calendar date — the same care 17.13 takes in the database.
 */
function localDate(date: DateString): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function shortDate(date: DateString): string {
  return DAY_MONTH.format(localDate(date));
}

export function longDate(date: DateString): string {
  return DAY_MONTH_YEAR.format(localDate(date));
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(new Date(y, m - 1, 1));
}

/** `09:12` from an instant, in the viewing device's zone — which is what a timed entry means. */
export function timeOfDay(instant: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(instant));
}

export function dateTime(instant: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}

/**
 * A plain number typed into a field, or `undefined` when what is there is not one (25.3).
 *
 * `Number(x) || 0` was in four places and is wrong twice over: `Number("abc")` is `NaN`, which
 * `|| 0` turns into a confident zero, and `Number("")` is already `0` with no `||` needed. Both
 * spellings mean a typo is stored as a real value and saved without a word — an hourly rate of
 * nothing, a prompt interval of forty-five minutes you did not ask for.
 *
 * Whitespace is tolerated because a value pasted from a spreadsheet carries it. Nothing else is:
 * `Number` alone would accept `"0x10"`, `"1e3"` and `"Infinity"`, none of which anybody types
 * into a rate box on purpose, and `"12abc"` is rejected rather than read as 12.
 */
export function parseNumber(text: string): number | undefined {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** `2h 30m` typed as `2:30`, `2.5`, `150m` or `2h30`. Returns null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  const colon = /^(\d+):([0-5]?\d)$/.exec(t);
  if (colon) return (Number(colon[1]) * 60 + Number(colon[2])) * 60_000;

  const hm = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m?)?$/.exec(t);
  if (hm && (hm[1] || hm[2])) {
    const h = Number(hm[1] ?? 0);
    const m = Number(hm[2] ?? 0);
    // `2h30` means two and a half hours; `2h` alone means two.
    return Math.round(h * 3_600_000 + m * 60_000);
  }

  const minutes = /^(\d+)\s*m$/.exec(t);
  if (minutes) return Number(minutes[1]) * 60_000;

  const decimal = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (decimal) return Math.round(Number(decimal[1]) * 3_600_000);

  return null;
}

/**
 * `HH:MM` on a plain date, as an instant on this device's clock (24.11, 24.12).
 *
 * The inverse of `timeOfDay`, and the same rule as 2.19: a wall-clock time means what it means
 * where the person typing it is standing. `new Date("2026-09-08T09:00")` — no zone suffix — is
 * parsed as local time, which is exactly that.
 *
 * Returns `undefined` rather than an Invalid Date, because the caller has a form to keep and a
 * message to show, and `NaN` reaching the server as a timestamp is how a NOT NULL column ends up
 * being the thing that reports a typo.
 */
export function instantAt(date: DateString, time: string): number | undefined {
  if (!/^\d{2}:\d{2}$/.test(time)) return undefined;
  const at = new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** `HH:MM` for a time input, from an instant. `timeOfDay` is for display and may localise. */
export function timeValue(instant: number): string {
  const d = new Date(instant);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
