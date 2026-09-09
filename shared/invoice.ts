/**
 * Turning a month of work into an invoice, and the rules about when that is allowed.
 *
 * Two decisions shape everything here, and both trade a general mechanism for one that can be
 * checked. **A period is a whole calendar month** (8.18), so "do these two invoices overlap?"
 * collapses from an interval test to a string comparison — and 11.19 becomes the far more testable
 * 11.20, *at most one issued-or-paid invoice per month*. And **an invoice takes every entry in its
 * period, with no filtering** (8.17), so nothing has to remember which work was "already billed";
 * the overlap rule is what prevents billing twice, and 21.14 defers the rest.
 *
 * Money is in **minor units as integers** throughout. Nothing here is a float dollar, because a
 * float dollar is a rounding argument waiting to happen on a document with legal weight.
 */

import type { DateString, Instant, InvoiceStatus, WorkEntry } from "./types.ts";
import { monthOf, weeksThenMonday } from "./dates.ts";
import { hoursOf, roundHours } from "./rounding.ts";

const MS_PER_HOUR = 3_600_000;

/** One row of the work/expense table (8.9, 8.10). */
export interface InvoiceLine {
  /** `null` on the monthly-bonus line, which is not attached to a day (9.9, 9.11). */
  date: DateString | null;
  /** 4.2 — the billing tag is the description, verbatim. */
  description: string;
  teamProject: string;
  hours: number | null;
  rateMinor: number | null;
  amountMinor: number;
}

export interface InvoiceTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** What an invoice looks like before it is issued, recomputed freely (8.16, 10.7). */
export interface InvoiceDraft extends InvoiceTotals {
  period: string;
  number: string;
  teamProject: string;
  currency: string;
  rateMinor: number;
  bonusMinor: number;
  /** A fraction, so 10% VAT is `0.1`. Zero where tax does not apply (8.11). */
  taxRate: number;
  /** 9.23 — when the invoice was drawn up. Not the period, and not the due date. */
  invoiceDate: DateString;
  dueDate: DateString;
  /**
   * 8.19 — the bonus is its own table in the supplied format, not the first row of the work one.
   *
   * Kept as a separate field rather than a flag on a line, because the two tables have different
   * columns filled in and different subtotals, and a renderer that had to re-derive which rows were
   * which would be one `filter` away from putting the bonus in the hours total.
   */
  bonusLine: InvoiceLine | null;
  /** The work rows only. */
  lines: InvoiceLine[];
  /** 8.22 — the work table's own Total row. */
  workHours: number;
  workSubtotalMinor: number;
  /** 11.23 — every entry that went in, so 11.25 can notice one that did not. */
  entryIds: string[];
}

/** The frozen copy taken at issuance (11.6, 10.8). */
export interface InvoiceSnapshot extends InvoiceDraft {
  issuedAt: Instant;
}

export interface InvoiceRecord {
  id: string;
  period: string;
  number: string;
  status: InvoiceStatus;
  /** Present once issued; 11.8 means later edits to work must not reach through this. */
  snapshot?: InvoiceSnapshot;
  issuedAt?: Instant;
  paidAt?: Instant;
}

/** 9.14 — derived from the period, and editable while the invoice is a draft (9.15). */
export function defaultInvoiceNumber(period: string): string {
  return `INV-${period}`;
}

/**
 * 10.1–10.4 — four weeks from the day the invoice is being prepared, then forward to Monday.
 *
 * From *today*, not from the end of the period: an invoice for September prepared in October is due
 * four weeks from October. That is what 10.1 says, and it is the reading that matches how the date
 * is used — it is when payment is expected, counted from when the bill went out.
 */
export function dueDateFor(preparedOn: DateString): DateString {
  return weeksThenMonday(preparedOn, 4);
}

/** Half-up to the nearest minor unit. Stated because a cent has to land somewhere. */
function money(value: number): number {
  return Math.round(value);
}

export interface BuildOptions {
  period: string;
  entries: readonly WorkEntry[];
  teamProject: string;
  rateMinor: number;
  bonusMinor: number;
  /** 8.21, 9.21 — the bonus row carries its own, because it is not work on the project. */
  bonusTeamProject?: string;
  currency: string;
  taxRate: number;
  number?: string;
  preparedOn: DateString;
}

/**
 * One row per date and billing tag, with the hours summed.
 *
 * Aggregating rather than one row per entry: the description column *is* the billing tag (4.2), so
 * two entries on one day with one tag would otherwise print the same sentence twice with the hours
 * split — which reads as a mistake even though it is not. Several tags on one day still print
 * several rows, which is what 4.4 asks for.
 */
export function buildLines(opts: BuildOptions): InvoiceLine[] {
  const inPeriod = opts.entries.filter((e) => monthOf(e.date) === opts.period);

  const byKey = new Map<string, { date: DateString; tag: string; ms: number }>();
  for (const e of inPeriod) {
    const key = `${e.date}\0${e.billingTag}`;
    const row = byKey.get(key) ?? { date: e.date, tag: e.billingTag, ms: 0 };
    row.ms += e.durationMs;
    byKey.set(key, row);
  }

  const timeLines: InvoiceLine[] = [...byKey.values()]
    .sort((a, b) => (a.date === b.date ? a.tag.localeCompare(b.tag) : a.date < b.date ? -1 : 1))
    .map((row) => {
      // 25.7 — the rounded figure is the official one, and the amount is computed from it rather
      // than from `row.ms`. Otherwise the column prints `2.5` and the total is struck from
      // `2.5083…`, and the invoice does not add up to what it shows. Up to three minutes a line.
      const hours = hoursOf(row.ms);
      return {
        date: row.date,
        description: row.tag,
        teamProject: opts.teamProject,
        hours,
        rateMinor: opts.rateMinor,
        amountMinor: money(hours * opts.rateMinor),
      };
    });

  return timeLines;
}

/**
 * 8.19–8.21 — the bonus row, or `null` when there is no bonus.
 *
 * Its Date cell is left empty here and rendered as the period (8.20): the row covers a month, not a
 * day, and putting a made-up date in it would make it sort and read like work.
 */
export function buildBonusLine(opts: BuildOptions): InvoiceLine | null {
  if (opts.bonusMinor === 0) return null;
  return {
    date: null,
    description: "Monthly bonus",
    teamProject: opts.bonusTeamProject ?? "General",
    hours: null,
    rateMinor: null,
    amountMinor: opts.bonusMinor,
  };
}

export function totalsFor(lines: readonly InvoiceLine[], taxRate: number): InvoiceTotals {
  const subtotalMinor = lines.reduce((t, l) => t + l.amountMinor, 0);
  const taxMinor = money(subtotalMinor * taxRate);
  return { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

/**
 * An edit to a draft's rows, made coherent again (25.11).
 *
 * **A detached draft is edited, and every edit invalidates the numbers below it.** Change one
 * line's hours and the line amount, the work total, the sub-total, the tax and the grand total are
 * all stale — five figures that have to move together or the document contradicts itself. That is
 * the whole failure 25.7 is about, arriving by a different route.
 *
 * So no caller updates a total. Callers hand over rows; this derives everything else, and it is
 * the only thing that does. The line amount comes from `hours × rate` where both are present and
 * is taken as given where they are not, which is what makes a flat-fee row — an expense, a
 * bonus — expressible without a fictional hourly rate to justify it.
 *
 * The hours are re-rounded on the way through. They arrive rounded from `buildLines` and from the
 * client's own field, so this normally changes nothing; it is here so a value that reached the
 * server by some other path cannot make the printed column disagree with the arithmetic.
 */
export function recomputeDraft(
  draft: InvoiceDraft,
  edit: { lines?: InvoiceLine[]; bonusLine?: InvoiceLine | null },
): InvoiceDraft {
  const lines = (edit.lines ?? draft.lines).map((l) => {
    const hours = l.hours === null ? null : roundHours(l.hours);
    return {
      ...l,
      hours,
      amountMinor: hours !== null && l.rateMinor !== null
        ? money(hours * l.rateMinor)
        : Math.round(l.amountMinor),
    };
  });
  const bonusLine = edit.bonusLine === undefined ? draft.bonusLine : edit.bonusLine;
  const totals = totalsFor(bonusLine ? [bonusLine, ...lines] : lines, draft.taxRate);

  return {
    ...draft,
    lines,
    bonusLine,
    // 8.22 — the work table's own total, which excludes the bonus. Summing the *rounded* line
    // hours rather than re-rounding the sum, so the Total cell is what the column above it adds to.
    workHours: Math.round(lines.reduce((t, l) => t + (l.hours ?? 0), 0) * 10) / 10,
    workSubtotalMinor: lines.reduce((t, l) => t + l.amountMinor, 0),
    bonusMinor: bonusLine?.amountMinor ?? 0,
    ...totals,
  };
}

export function buildDraft(opts: BuildOptions): InvoiceDraft {
  const lines = buildLines(opts);
  const bonusLine = buildBonusLine(opts);
  const totals = totalsFor(bonusLine ? [bonusLine, ...lines] : lines, opts.taxRate);
  return {
    period: opts.period,
    number: opts.number ?? defaultInvoiceNumber(opts.period),
    teamProject: opts.teamProject,
    currency: opts.currency,
    rateMinor: opts.rateMinor,
    bonusMinor: opts.bonusMinor,
    taxRate: opts.taxRate,
    invoiceDate: opts.preparedOn,
    dueDate: dueDateFor(opts.preparedOn),
    bonusLine,
    lines,
    workHours: lines.reduce((t, l) => t + (l.hours ?? 0), 0),
    workSubtotalMinor: lines.reduce((t, l) => t + l.amountMinor, 0),
    entryIds: opts.entries.filter((e) => monthOf(e.date) === opts.period).map((e) => e.id).sort(),
    ...totals,
  };
}

/** An invoice that has accounting weight: 11.20 counts these, and drafts are not among them. */
export function isCommitted(inv: InvoiceRecord): boolean {
  return inv.status === "issued" || inv.status === "paid";
}

export type IssueRefusal =
  | { ok: true }
  | { ok: false; reason: "period-taken"; by: InvoiceRecord }
  | { ok: false; reason: "number-taken"; by: InvoiceRecord };

/**
 * Whether this draft may be issued (11.19, 11.20, 9.16).
 *
 * Reverting an issuance puts the invoice back to `draft`, which frees its period by the same test
 * — that is 11.21 with no code of its own. Drafts never conflict with anything (11.22).
 */
export function canIssue(draft: InvoiceDraft, existing: readonly InvoiceRecord[]): IssueRefusal {
  const committed = existing.filter(isCommitted);
  const clash = committed.find((i) => i.period === draft.period);
  if (clash) return { ok: false, reason: "period-taken", by: clash };
  const dupe = committed.find((i) => i.number === draft.number);
  if (dupe) return { ok: false, reason: "number-taken", by: dupe };
  return { ok: true };
}

/**
 * 9.13 — "the previous invoice" is the one with the most recent *period*, drafts included.
 *
 * Generic over the record type so a caller holding richer rows — the server's, which carry the
 * stored draft — gets its own type back rather than the bare `InvoiceRecord` this file defines.
 */
export function previousInvoice<T extends InvoiceRecord>(
  existing: readonly T[],
  before?: string,
): T | undefined {
  return existing
    .filter((i) => (before === undefined ? true : i.period < before))
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))[0];
}

export type InvoiceWarning =
  | { kind: "uninvoiced-month"; month: string; hours: number; laterInvoice: InvoiceRecord }
  | { kind: "missing-from-invoice"; entry: WorkEntry; invoice: InvoiceRecord };

/**
 * Work that looks like it has been billed but has not (11.24, 11.25). Neither blocks (11.26).
 *
 * The second case is the one that will actually happen: you issue September, then remember two
 * hours on the 12th. That month *is* invoiced, so the first check would say nothing about it — and
 * it is money. The snapshot's entry list (11.23) makes it a set difference.
 */
export function invoiceWarnings(
  entries: readonly WorkEntry[],
  invoices: readonly InvoiceRecord[],
): InvoiceWarning[] {
  const committed = invoices.filter(isCommitted);
  const byMonth = new Map(committed.map((i) => [i.period, i]));
  const latest = committed.reduce<InvoiceRecord | undefined>(
    (best, i) => (best === undefined || i.period > best.period ? i : best),
    undefined,
  );

  const out: InvoiceWarning[] = [];

  // 11.24 -- a month with work in it that was skipped, while a later month was billed.
  if (latest) {
    const hoursByMonth = new Map<string, number>();
    for (const e of entries) {
      const m = monthOf(e.date);
      hoursByMonth.set(m, (hoursByMonth.get(m) ?? 0) + e.durationMs / MS_PER_HOUR);
    }
    for (const [month, hours] of [...hoursByMonth].sort()) {
      if (month < latest.period && !byMonth.has(month)) {
        out.push({ kind: "uninvoiced-month", month, hours, laterInvoice: latest });
      }
    }
  }

  // 11.25 -- work inside an invoiced month that the invoice does not know about.
  for (const e of entries) {
    const inv = byMonth.get(monthOf(e.date));
    if (!inv) continue;
    const ids = inv.snapshot?.entryIds;
    if (ids && !ids.includes(e.id)) {
      out.push({ kind: "missing-from-invoice", entry: e, invoice: inv });
    }
  }

  return out;
}
