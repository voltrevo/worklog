/**
 * Monthly totals (section 7).
 *
 * **Every figure here comes from `durationMs`**, never from the timings (7.3, 2.13). A timed entry
 * and a duration-only one are the same kind of number to a report, which is the whole reason 2.9
 * can exist: two hours you half remember are worth exactly two hours, and nothing downstream has
 * to know which sort it was.
 *
 * **Invoice state is derived, not stored** (7.11). An entry does not carry a flag saying it has
 * been billed; it is billed if a committed invoice covers its month, and paid if that invoice is
 * paid. That falls out of a month being the unit of invoicing, and it means the two can never
 * disagree — there is only one fact.
 */

import type { DateString, WorkEntry } from "./types.ts";
import { monthOf, MS_PER_HOUR } from "./dates.ts";
import { type InvoiceRecord, isCommitted } from "./invoice.ts";

/** 7.8 — the three states work can be in, from the invoice covering it. */
export type WorkState = "uninvoiced" | "invoiced" | "paid";

export interface TagTotal {
  tag: string;
  hours: number;
  /** How many days this tag appears on, which is the difference between a habit and an afternoon. */
  days: number;
  /** Of the month's total. `0.25` is a quarter. */
  share: number;
}

export interface DayTotal {
  date: DateString;
  hours: number;
}

export interface MonthReport {
  month: string;
  /** 7.2 */
  totalHours: number;
  /** 7.6 — largest first, because the question is nearly always "what took the time". */
  byTag: TagTotal[];
  /** 7.5 — every day that has work on it, in order. */
  byDay: DayTotal[];
  /** 7.8 */
  state: WorkState;
  /** The invoice that decides `state`, when there is one. */
  invoiceNumber?: string;
}

/**
 * What state a month's work is in.
 *
 * A draft counts for nothing (11.3): it has no accounting meaning, so work in a month that has
 * only a draft is uninvoiced — which is exactly what somebody chasing unbilled hours wants it to
 * say.
 */
export function stateOf(
  month: string,
  invoices: readonly InvoiceRecord[],
): { state: WorkState; invoice?: InvoiceRecord } {
  const committed = invoices.filter(isCommitted).find((i) => i.period === month);
  if (!committed) return { state: "uninvoiced" };
  return { state: committed.status === "paid" ? "paid" : "invoiced", invoice: committed };
}

export function monthReport(
  month: string,
  entries: readonly WorkEntry[],
  invoices: readonly InvoiceRecord[] = [],
): MonthReport {
  const inMonth = entries.filter((e) => monthOf(e.date) === month);
  const totalHours = inMonth.reduce((t, e) => t + e.durationMs, 0) / MS_PER_HOUR;

  const tags = new Map<string, { ms: number; days: Set<DateString> }>();
  const days = new Map<DateString, number>();
  for (const e of inMonth) {
    const tag = tags.get(e.billingTag) ?? { ms: 0, days: new Set<DateString>() };
    tag.ms += e.durationMs;
    tag.days.add(e.date);
    tags.set(e.billingTag, tag);
    days.set(e.date, (days.get(e.date) ?? 0) + e.durationMs);
  }

  const { state, invoice } = stateOf(month, invoices);

  return {
    month,
    totalHours,
    byTag: [...tags]
      .map(([tag, v]) => ({
        tag,
        hours: v.ms / MS_PER_HOUR,
        days: v.days.size,
        // Guarded, because a month with no work would otherwise divide by zero and report NaN%
        // in a table that looks perfectly reasonable until somebody reads it.
        share: totalHours > 0 ? v.ms / MS_PER_HOUR / totalHours : 0,
      }))
      .sort((a, b) => (b.hours - a.hours) || a.tag.localeCompare(b.tag)),
    byDay: [...days]
      .map(([date, ms]) => ({ date, hours: ms / MS_PER_HOUR }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    state,
    ...(invoice ? { invoiceNumber: invoice.number } : {}),
  };
}

/**
 * 7.4 — totals over an arbitrary half-open range, which nothing in v1 exposes (7.9).
 *
 * Kept because the internal support is what 7.4 asks for, and because it is the one function here
 * that would be awkward to add later: everything else is grouped by month because the *UI* offers
 * months, not because the data insists on it.
 */
export function rangeHours(
  entries: readonly WorkEntry[],
  from: DateString,
  to: DateString,
): number {
  return entries
    .filter((e) => e.date >= from && e.date < to)
    .reduce((t, e) => t + e.durationMs, 0) / MS_PER_HOUR;
}
