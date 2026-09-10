import { assertEquals } from "jsr:@std/assert@^1";
import type { WorkEntry } from "./types.ts";
import {
  buildDraft,
  buildLines,
  canIssue,
  defaultInvoiceNumber,
  documentFor,
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

Deno.test("8.19-8.21 -- the bonus is its own table, not the first row of the work one", () => {
  // The supplied format puts it above the work table with its own subtotal, so it is a separate
  // field rather than a line with a flag: the two tables fill in different columns, and a renderer
  // that had to re-derive which rows were which is one `filter` away from adding the bonus into
  // the hours total.
  const entries = [entry("a", "2026-09-01", 8)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries, bonusMinor: 10_000 });

  assertEquals(draft.lines.length, 1, "the work table holds only work");
  assertEquals(draft.lines[0]?.date, "2026-09-01");

  assertEquals(draft.bonusLine?.description, "Monthly bonus");
  assertEquals(draft.bonusLine?.date, null, "8.20 -- it covers a period, not a day");
  assertEquals(draft.bonusLine?.hours, null);
  assertEquals(draft.bonusLine?.rateMinor, null);
  assertEquals(draft.bonusLine?.amountMinor, 10_000);
  assertEquals(draft.bonusLine?.teamProject, "General", "8.21 -- and its own Team/Project");

  // 8.22 -- the work table's own Total row excludes the bonus; the invoice total includes it.
  assertEquals(draft.workSubtotalMinor, 60_000);
  assertEquals(draft.workHours, 8);
  assertEquals(draft.subtotalMinor, 70_000);
});

Deno.test("the bonus Team/Project is configurable and defaults to General", () => {
  const draft = buildDraft({
    ...BASE,
    period: "2026-09",
    entries: [],
    bonusMinor: 5_000,
    bonusTeamProject: "Retainer",
  });
  assertEquals(draft.bonusLine?.teamProject, "Retainer");
});

Deno.test("a zero bonus produces no bonus table at all", () => {
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [entry("a", "2026-09-01", 8)] });
  assertEquals(draft.bonusLine, null);
  assertEquals(draft.lines.length, 1);
  assertEquals(
    buildLines({ ...BASE, period: "2026-09", entries: [entry("a", "2026-09-01", 8)] }).length,
    1,
  );
});

Deno.test("9.23 -- the invoice date, the period and the due date are three different things", () => {
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [], preparedOn: "2026-10-01" });
  assertEquals(draft.period, "2026-09");
  assertEquals(draft.invoiceDate, "2026-10-01");
  assertEquals(draft.dueDate, "2026-11-02");
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
  assertEquals(draft.bonusLine?.amountMinor, 10_000);
  assertEquals(draft.lines.map((l) => l.amountMinor), [56_250, 60_000]);
  assertEquals(draft.subtotalMinor, 126_250);
  assertEquals(draft.taxMinor, 12_625);
  assertEquals(draft.totalMinor, 138_875);
  assertEquals(Number.isInteger(draft.totalMinor), true);
});

Deno.test("25.7 -- the invoice adds up to the hours printed on it", () => {
  // The check that would have caught the old behaviour. Each of these is 2h30m30s, which prints as
  // `2.5`; three of them at 75.00 must come to 562.50, the number a client gets by multiplying what
  // they can see. Computing from the unrounded 2.5083h gave 564.38 — a total that cannot be
  // reconstructed from any figure on the page, which is the kind of discrepancy that costs an email.
  const awkward = (2 * 3600 + 30 * 60 + 30) / 3600;
  const draft = buildDraft({
    ...BASE,
    period: "2026-09",
    entries: [
      entry("a", "2026-09-01", awkward),
      entry("b", "2026-09-02", awkward),
      entry("c", "2026-09-03", awkward),
    ],
  });
  assertEquals(draft.lines.map((l) => l.hours), [2.5, 2.5, 2.5]);
  assertEquals(draft.workHours, 7.5);
  for (const line of draft.lines) assertEquals(line.amountMinor, 18750);
  assertEquals(draft.subtotalMinor, 56250);
  // Restated as the property rather than the arithmetic: whatever the lines say, the total is
  // their sum, and each line is its own printed hours times the rate.
  for (const line of draft.lines) {
    assertEquals(line.amountMinor, Math.round(line.hours! * BASE.rateMinor));
  }
  assertEquals(draft.subtotalMinor, draft.lines.reduce((t, l) => t + l.amountMinor, 0));
});

Deno.test("a tenth of an hour can still be a fraction of a cent", () => {
  // Freezing the hours does not remove the need to round money: 0.1h at 123.45 is 12.345. Half-up
  // to the cent, and the result is a whole number of minor units rather than a trailing fraction.
  const odd = buildDraft({
    ...BASE,
    rateMinor: 12345,
    period: "2026-09",
    entries: [entry("a", "2026-09-01", 0.1)],
  });
  assertEquals(odd.lines.map((l) => l.hours), [0.1]);
  assertEquals(Number.isInteger(odd.subtotalMinor), true);
  assertEquals(odd.subtotalMinor, 1235); // 12.345 -> 12.35
});

Deno.test("a minute of work rounds away, and says so by being zero", () => {
  // 25.6 accepts up to three minutes a line. One minute is 0.0h and bills nothing — which is the
  // honest outcome and is visible on the invoice as `0.0`, rather than a cent appearing from a
  // duration too small to print.
  const draft = buildDraft({
    ...BASE,
    period: "2026-09",
    entries: [entry("a", "2026-09-01", 1 / 60)],
  });
  assertEquals(draft.lines.map((l) => l.hours), [0]);
  assertEquals(draft.subtotalMinor, 0);
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

/*
 * The other direction, which nothing was watching.
 *
 * 11.25 asks about an entry that is *not* in the snapshot, and that is the case somebody thought
 * of: you issue September, then remember two hours on the 12th. The reverse — an entry that was on
 * the invoice and has since been shortened or deleted — leaves every id in the snapshot still
 * accounted for, so the set difference is empty and nothing is said. It is also the worse of the
 * two, because the invoice is then claiming money the records no longer support.
 */
Deno.test("work behind an issued invoice that has since been deleted", () => {
  const original = [entry("a", "2026-09-01", 8), entry("b", "2026-09-02", 4)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: original });
  const invoices: InvoiceRecord[] = [{
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
    snapshot: { ...draft, issuedAt: 1_759_000_000_000 },
  }];
  assertEquals(invoiceWarnings(original, invoices).length, 0);

  const warnings = invoiceWarnings([original[0]!], invoices);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.kind, "invoiced-work-changed");
  assertEquals(
    warnings[0]?.kind === "invoiced-work-changed" && warnings[0].wasHours,
    12,
  );
  assertEquals(warnings[0]?.kind === "invoiced-work-changed" && warnings[0].nowHours, 8);
});

Deno.test("and work behind an issued invoice that has since been shortened", () => {
  const original = [entry("a", "2026-09-01", 8)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: original });
  const invoices: InvoiceRecord[] = [{
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
    snapshot: { ...draft, issuedAt: 1_759_000_000_000 },
  }];

  // The same entry, same id, two hours shorter. Every id the snapshot names is still present, so
  // 11.25's set difference sees nothing at all.
  const warnings = invoiceWarnings([entry("a", "2026-09-01", 6)], invoices);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.kind, "invoiced-work-changed");
  assertEquals(warnings[0]?.kind === "invoiced-work-changed" && warnings[0].nowHours, 6);
});

Deno.test("adding work to an invoiced month is reported once, as the addition it is", () => {
  // The aggregate check looks only at the entries the invoice was built from, so an addition does
  // not also read as a change to them — otherwise every 11.25 warning would arrive with a vaguer
  // duplicate beside it.
  const original = [entry("a", "2026-09-01", 8)];
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: original });
  const invoices: InvoiceRecord[] = [{
    id: "1",
    period: "2026-09",
    number: "INV-2026-09",
    status: "issued",
    snapshot: { ...draft, issuedAt: 1_759_000_000_000 },
  }];
  const warnings = invoiceWarnings([...original, entry("late", "2026-09-12", 2)], invoices);
  assertEquals(warnings.map((w) => w.kind), ["missing-from-invoice"]);
});

Deno.test("27.36 -- the warning pass stays linear in how much work there is", () => {
  /*
   * `invoiceWarnings` runs on every snapshot, which is every event the server pushes to every
   * connected device. It used to ask `snapshot.entryIds.includes(id)` — a scan of one invoice's
   * ids — once per entry, inside a loop over every invoice, so its cost grew with the *product* of
   * the two. Measured against a database: 1.9ms at two years of recorded work, 85ms at twenty.
   *
   * A wall-clock bound would be a flake on a shared machine. The shape is the property worth
   * defending, and it is robust to how fast the machine is: quadruple the input and linear work
   * takes about four times as long, while quadratic work takes about sixteen. The threshold sits
   * between those, nearer the wrong answer, so the test fails on a return to quadratic and not on
   * a slow morning.
   */
  const build = (years: number) => {
    const entries: WorkEntry[] = [];
    const invoices: InvoiceRecord[] = [];
    for (let y = 0; y < years; y++) {
      for (let m = 1; m <= 12; m++) {
        const period = `2016-${String(m).padStart(2, "0")}`.replace("2016", String(2016 + y));
        const mine: WorkEntry[] = [];
        for (let d = 1; d <= 22; d++) {
          const e = entry(
            `${period}-${d}`,
            `${period}-${String(d).padStart(2, "0")}`,
            8,
          );
          mine.push(e);
          entries.push(e);
        }
        const draft = buildDraft({ ...BASE, period, entries: mine });
        invoices.push({
          id: period,
          period,
          number: `INV-${period}`,
          status: "issued",
          snapshot: { ...draft, issuedAt: 1_759_000_000_000 },
        });
      }
    }
    return { entries, invoices };
  };

  const time = (years: number) => {
    const { entries, invoices } = build(years);
    // Once to let the engine settle, then the measured pass.
    invoiceWarnings(entries, invoices);
    const started = performance.now();
    invoiceWarnings(entries, invoices);
    return performance.now() - started;
  };

  const small = Math.max(time(3), 0.05);
  const large = time(12);
  const ratio = large / small;
  assertEquals(
    ratio < 8,
    true,
    `four times the work took ${ratio.toFixed(1)}x the time ` +
      `(${small.toFixed(1)}ms then ${large.toFixed(1)}ms); linear is about 4x, quadratic about 16x`,
  );
});

Deno.test("27.42 -- what an invoice says now, in each state it can be in", () => {
  /*
   * The rule three call sites got subtly different. `snapshot ?? draft` is right until an
   * issuance is reverted, at which point the snapshot is a record of the past and the draft is
   * what the invoice says — and the list, and the PDF re-render, both went on reading the past.
   */
  const draft = buildDraft({ ...BASE, period: "2026-09", entries: [entry("a", "2026-09-01", 8)] });
  const edited = buildDraft({
    ...BASE,
    period: "2026-09",
    entries: [entry("a", "2026-09-01", 1)],
  });
  const frozen = { ...draft, issuedAt: 1_759_000_000_000 };

  // A draft that has never been issued: there is only one answer.
  assertEquals(documentFor({ status: "draft", draft }).workHours, draft.workHours);

  // Issued, and paid: the snapshot, because that is what was sent.
  assertEquals(
    documentFor({ status: "issued", draft: edited, snapshot: frozen }).workHours,
    draft.workHours,
  );
  assertEquals(
    documentFor({ status: "paid", draft: edited, snapshot: frozen }).workHours,
    draft.workHours,
  );

  // Reverted, and then edited: the draft. The snapshot is still there — it is the record of an
  // issuance that happened — and it is no longer what this invoice says.
  assertEquals(
    documentFor({ status: "draft", draft: edited, snapshot: frozen }).workHours,
    edited.workHours,
  );
  assertEquals(
    draft.workHours === edited.workHours,
    false,
    "the two drafts must differ or this test cannot fail",
  );
});
