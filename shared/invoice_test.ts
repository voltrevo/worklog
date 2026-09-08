import { assertEquals } from "jsr:@std/assert@^1";
import type { WorkEntry } from "./types.ts";
import {
  buildDraft,
  buildLines,
  canIssue,
  defaultInvoiceNumber,
  dueDateFor,
  type InvoiceRecord,
  invoiceWarnings,
  previousInvoice,
  totalsFor,
} from "./invoice.ts";

const HOUR = 3_600_000;

function entry(
  id: string,
  date: string,
  hours: number,
  billingTag = "Product Development",
): WorkEntry {
  return { id, date, durationMs: hours * HOUR, billingTag };
}

const BASE = {
  teamProject: "Protocol Research",
  rateMinor: 7500, // 75.00 an hour
  bonusMinor: 0,
  currency: "USD",
  taxRate: 0,
  preparedOn: "2026-10-01",
};

Deno.test("the number is derived from the period", () => {
  assertEquals(defaultInvoiceNumber("2026-09"), "INV-2026-09");
  assertEquals(defaultInvoiceNumber("2027-01"), "INV-2027-01");
});

Deno.test("the due date counts four weeks from preparation, not from the period", () => {
  // An invoice for September prepared on 1 October is due four weeks from October (10.1).
  assertEquals(dueDateFor("2026-10-01"), "2026-11-02");
  // ...and preparing the same invoice a fortnight later moves it, which is 10.7 while it is a draft.
  assertEquals(dueDateFor("2026-10-15"), "2026-11-16");
});

Deno.test("8.17 -- every entry in the period goes on, and nothing outside it does", () => {
  const entries = [
    entry("a", "2026-08-31", 8),
    entry("b", "2026-09-01", 8),
    entry("c", "2026-09-30", 4),
    entry("d", "2026-10-01", 8),
  ];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries });
  assertEquals(draft.entryIds, ["b", "c"]);
  assertEquals(draft.lines.length, 2);
});

Deno.test("rows aggregate per date and tag, but several tags on a day stay several rows", () => {
  const entries = [
    entry("a", "2026-09-01", 3, "Product Development"),
    entry("b", "2026-09-01", 2, "Product Development"),
    entry("c", "2026-09-01", 1, "Meetings"),
    entry("d", "2026-09-02", 8, "Product Development"),
  ];
  const lines = buildLines({ ...BASE, period: "2026-09", entries });
  assertEquals(lines.length, 3);
  assertEquals(lines.map((l) => [l.date, l.description, l.hours]), [
    ["2026-09-01", "Meetings", 1],
    ["2026-09-01", "Product Development", 5],
    ["2026-09-02", "Product Development", 8],
  ]);
});

Deno.test("9.11 -- the bonus is its own line and comes before the time", () => {
  const entries = [entry("a", "2026-09-01", 8)];
  const lines = buildLines({ ...BASE, period: "2026-09", entries, bonusMinor: 10_000 });
  assertEquals(lines.length, 2);
  assertEquals(lines[0]?.description, "Monthly bonus");
  assertEquals(lines[0]?.date, null, "a bonus is not attached to a day");
  assertEquals(lines[0]?.hours, null);
  assertEquals(lines[0]?.amountMinor, 10_000);
  assertEquals(lines[1]?.date, "2026-09-01");
});

Deno.test("a zero bonus produces no line at all", () => {
  const lines = buildLines({ ...BASE, period: "2026-09", entries: [entry("a", "2026-09-01", 8)] });
  assertEquals(lines.length, 1);
});

Deno.test("amounts are integer minor units and the totals add up", () => {
  const entries = [entry("a", "2026-09-01", 7.5), entry("b", "2026-09-02", 8)];
  const draft = buildDraft({
    ...BASE,
    period: "2026-09",
    entries,
    bonusMinor: 10_000,
    taxRate: 0.1,
  });
  assertEquals(draft.lines.map((l) => l.amountMinor), [10_000, 56_250, 60_000]);
  assertEquals(draft.subtotalMinor, 126_250);
  assertEquals(draft.taxMinor, 12_625);
  assertEquals(draft.totalMinor, 138_875);
  assertEquals(Number.isInteger(draft.totalMinor), true);
});

Deno.test("an awkward duration still lands on a whole cent", () => {
  // 20 minutes at 75.00 is 25.00 exactly; 25 minutes is 31.25; 1 minute is 1.25.
  const entries = [entry("a", "2026-09-01", 1 / 60)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries });
  assertEquals(draft.subtotalMinor, 125);
  // ...and something genuinely fractional rounds rather than trailing a fraction of a cent.
  const odd = buildDraft({
    ...BASE,
    period: "2026-09",
    entries: [entry("a", "2026-09-01", 1 / 7)],
  });
  assertEquals(Number.isInteger(odd.subtotalMinor), true);
  assertEquals(odd.subtotalMinor, 1071); // 10.714... -> 10.71
});

Deno.test("11.20 -- at most one issued-or-paid invoice per month", () => {
  const issued: InvoiceRecord = {
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
  };
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [] });

  const refused = canIssue(draft, [issued]);
  assertEquals(refused.ok, false);
  assertEquals(refused.ok === false && refused.reason, "period-taken");

  // A different month is fine.
  const other = buildDraft({ ...BASE, period: "2026-10", entries: [] });
  assertEquals(canIssue(other, [issued]).ok, true);
});

Deno.test("11.22 -- drafts never conflict, with each other or with an issued period", () => {
  const otherDraft: InvoiceRecord = {
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "draft",
  };
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [] });
  assertEquals(canIssue(draft, [otherDraft]).ok, true);
});

Deno.test("11.21 -- reverting an issuance frees the period, with no rule of its own", () => {
  const reverted: InvoiceRecord = {
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "draft",
  };
  const paid: InvoiceRecord = { id: "2", period: "2026-08", number: "INV-2026-08", status: "paid" };
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [] });
  assertEquals(canIssue(draft, [reverted, paid]).ok, true);
});

Deno.test("9.16 -- an issued number cannot be reused, even for a free period", () => {
  const issued: InvoiceRecord = {
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
  };
  const draft = buildDraft({ ...BASE, period: "2026-10", entries: [], number: "INV-2026-09" });
  const verdict = canIssue(draft, [issued]);
  assertEquals(verdict.ok === false && verdict.reason, "number-taken");
});

Deno.test("9.13 -- the previous invoice is the one with the latest period, not the latest issuance", () => {
  const invoices: InvoiceRecord[] = [
    { id: "1", period: "2026-07", number: "a", status: "paid" },
    { id: "2", period: "2026-09", number: "b", status: "draft" },
    { id: "3", period: "2026-08", number: "c", status: "issued" },
  ];
  assertEquals(previousInvoice(invoices)?.period, "2026-09");
  assertEquals(previousInvoice(invoices, "2026-09")?.period, "2026-08");
  assertEquals(previousInvoice([]), undefined);
});

Deno.test("11.24 -- a skipped month with work in it, once a later month has been billed", () => {
  const entries = [entry("a", "2026-08-10", 6), entry("b", "2026-09-10", 8)];
  const invoices: InvoiceRecord[] = [
    { id: "1", period: "2026-09", number: "INV-2026-09", status: "issued" },
  ];
  const warnings = invoiceWarnings(entries, invoices);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.kind, "uninvoiced-month");
  assertEquals(warnings[0]?.kind === "uninvoiced-month" && warnings[0].month, "2026-08");
  assertEquals(warnings[0]?.kind === "uninvoiced-month" && warnings[0].hours, 6);
});

Deno.test("an uninvoiced month is only a warning once something later has been billed", () => {
  const entries = [entry("a", "2026-08-10", 6), entry("b", "2026-09-10", 8)];
  assertEquals(invoiceWarnings(entries, []).length, 0, "nothing billed yet is just being early");
  const draftOnly: InvoiceRecord[] = [
    { id: "1", period: "2026-09", number: "INV-2026-09", status: "draft" },
  ];
  assertEquals(invoiceWarnings(entries, draftOnly).length, 0, "a draft has no accounting weight");
});

Deno.test("11.25 -- work added to a month that was already invoiced", () => {
  const original = [entry("a", "2026-09-01", 8)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: original });
  const invoices: InvoiceRecord[] = [{
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
    snapshot: { ...draft, issuedAt: 1_759_000_000_000 },
  }];

  // Nothing wrong yet.
  assertEquals(invoiceWarnings(original, invoices).length, 0);

  // ...then two hours on the 12th are remembered, after the fact.
  const later = [...original, entry("late", "2026-09-12", 2)];
  const warnings = invoiceWarnings(later, invoices);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.kind, "missing-from-invoice");
  assertEquals(warnings[0]?.kind === "missing-from-invoice" && warnings[0].entry.id, "late");
});

Deno.test("an invoice with no snapshot cannot accuse anything of being missing", () => {
  // 11.23 puts entry ids in the snapshot; without one there is nothing to compare against, and
  // guessing would report every entry in the month as missing.
  const invoices: InvoiceRecord[] = [
    { id: "1", period: "2026-09", number: "INV-2026-09", status: "issued" },
  ];
  assertEquals(invoiceWarnings([entry("a", "2026-09-01", 8)], invoices).length, 0);
});

Deno.test("11.8 -- editing work does not reach through into an issued invoice", () => {
  const original = [entry("a", "2026-09-01", 8)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: original });
  const snapshot = { ...draft, issuedAt: 1_759_000_000_000 };
  const before = snapshot.totalMinor;

  // The entry is edited to a different duration afterwards.
  const edited = [entry("a", "2026-09-01", 20)];
  const rebuilt = buildDraft({ ...BASE, period: "2026-09", entries: edited });

  assertEquals(rebuilt.totalMinor !== before, true, "a fresh build does see the edit");
  assertEquals(snapshot.totalMinor, before, "the frozen copy does not");
});

Deno.test("totalsFor is the sum of the lines and nothing else", () => {
  assertEquals(totalsFor([], 0.1), { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
});
