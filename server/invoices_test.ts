import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { type Db, open } from "./db.ts";
import { getConfig, missingInvoiceConfig, setConfig } from "./config.ts";
import { addEntry, entriesInMonth, Refused, updateEntry } from "./work.ts";
import {
  attachPdf,
  createDraft,
  frozenConfigFor,
  getInvoice,
  invoiceForPeriod,
  issue,
  listInvoices,
  markPaid,
  paymentOverrideFor,
  revertIssue,
  unmarkPaid,
  updateDraft,
} from "./invoices.ts";

import { COMPLETE_INVOICE_CONFIG } from "./fixtures.ts";
import { bonusLineFor } from "../shared/invoice.ts";

/** Every string field blanked, to see the whole list at once. */
const BLANK = {
  fromName: "",
  fromAddress: "",
  clientName: "",
  clientAddress: "",
  currency: "",
  teamProject: "",
  payMethod: "",
  payName: "",
  payBsb: "",
  payAccountNumber: "",
  payBank: "",
  rateMinor: 0,
};

const HOUR = 3_600_000;
const T0 = 1_788_000_000_000;
/*
 * 27.51 — the day the issuing device is on. Fixed, so these tests stop inheriting the real
 * `today()`: an invoice date that changes with the calendar is a test that asserts less each day.
 */
const ISSUED_ON = "2026-09-01";

function fresh(): Db {
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", {
    fromName: "Wren Consulting",
    clientName: "Kestrel Labs",
    currency: "AUD",
    rateMinor: 7500,
    taxRate: 0.1,
    teamProject: "Protocol Research",
    payName: "Wren & Co",
    payBsb: "000-000",
    payAccountNumber: "00000000",
    payBank: "Bank of Nowhere",
  }, T0);
  return db;
}

function work(db: Db, date: string, hours: number, tag = "Product Development") {
  return addEntry(db, { date, durationMs: hours * HOUR, billingTag: tag }, T0);
}

Deno.test("a draft is seeded from the work as it stands", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const first = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(first.status, "draft");
  assertEquals(first.number, "INV-2026-09");
  assertEquals(first.draft.subtotalMinor, 60_000);
  db.close();
});

Deno.test("25.10 -- asking again makes a second draft rather than overwriting the first", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const first = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  work(db, "2026-09-02", 2);
  const second = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0 + 1000);

  // The old behaviour was `second.id === first.id` with the first one's contents replaced. Under
  // 25.11 a draft can have been edited, so overwriting it silently destroys work; and 25.10 says
  // overlapping drafts are allowed outright.
  assertEquals(listInvoices(db).length, 2);
  assertEquals(second.id === first.id, false);
  assertEquals(getInvoice(db, first.id)?.draft.subtotalMinor, 60_000, "the first is untouched");
  assertEquals(second.draft.subtotalMinor, 75_000, "the second sees the newer work");
});

Deno.test("and the second one is not called the same thing as the first", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  assertEquals(
    createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0).number,
    "INV-2026-09",
  );
  assertEquals(
    createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0).number,
    "INV-2026-09-2",
  );
  assertEquals(
    createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0).number,
    "INV-2026-09-3",
  );
  // Two rows reading `INV-2026-09` in a list with a Delete on each is a list you cannot act on.
  db.close();
});

Deno.test("25.11 -- a draft is detached: editing it does not touch the work, and vice versa", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const created = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(created.draft.lines.length, 1);

  // Edit the copy: correct the description, drop the hours to 6, and add a flat-fee row.
  const edited = updateDraft(db, created.id, {
    lines: [
      { ...created.draft.lines[0]!, description: "Discovery workshop", hours: 6 },
      {
        date: "2026-09-30",
        description: "Travel",
        teamProject: "Protocol Research",
        hours: null,
        rateMinor: null,
        amountMinor: 12_500,
      },
    ],
  }, T0 + 1000);

  assertEquals(edited.draft.lines.map((l) => l.description), ["Discovery workshop", "Travel"]);
  // Derived, not accepted: 6h at 75.00 is 450.00, plus the flat 125.00.
  assertEquals(edited.draft.lines.map((l) => l.amountMinor), [45_000, 12_500]);
  assertEquals(edited.draft.workHours, 6);
  assertEquals(edited.draft.subtotalMinor, 57_500);

  // The work entry is exactly as it was -- this is the half of 25.11 that says History is untouched.
  assertEquals(entriesInMonth(db, "2026-09").map((e) => e.durationMs), [8 * HOUR]);

  // ...and new work does not reach back into the draft.
  work(db, "2026-09-15", 4);
  assertEquals(getInvoice(db, created.id)?.draft.subtotalMinor, 57_500);
  db.close();
});

Deno.test("an edited draft is what gets frozen, not a rebuild of the work", () => {
  // The worst version of this bug: issuing is the one action that cannot be undone, and it used to
  // discard every edit at exactly that moment by rebuilding from the entries first.
  const db = fresh();
  work(db, "2026-09-01", 8);
  const created = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  updateDraft(db, created.id, {
    lines: [{ ...created.draft.lines[0]!, hours: 6 }],
  }, T0 + 1000);

  const issued = issue(db, created.id, T0 + 2000, ISSUED_ON);
  assertEquals(issued.snapshot?.workHours, 6);
  assertEquals(issued.snapshot?.subtotalMinor, 45_000);
  db.close();
});

Deno.test("an issued invoice refuses to be edited", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const created = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, created.id, T0, ISSUED_ON);
  assertThrows(
    () => updateDraft(db, created.id, { lines: [] }, T0),
    Refused,
    "issued",
  );
  db.close();
});

Deno.test("9.8/9.10/9.13 -- Team/Project and bonus default from the previous period", () => {
  const db = fresh();
  work(db, "2026-08-03", 8);
  createDraft(db, {
    period: "2026-08",
    teamProject: "Client Onboarding",
    bonusMinor: 25_000,
    preparedOn: "2026-09-01",
  }, T0);

  work(db, "2026-09-01", 8);
  const sept = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(sept.draft.teamProject, "Client Onboarding");
  assertEquals(sept.draft.bonusMinor, 25_000);
  assertEquals(sept.draft.bonusLine?.description, "Monthly bonus", "8.19 -- in its own table");
  db.close();
});

Deno.test("the seed config is used when there is no previous invoice", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const first = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(first.draft.teamProject, "Protocol Research");
  assertEquals(first.draft.bonusMinor, 0);
  db.close();
});

Deno.test("11.6 -- issuing freezes the work as it is at that moment", () => {
  const db = fresh();
  const entry = work(db, "2026-09-01", 8);
  createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  const issued = issue(db, invoiceForPeriod(db, "2026-09")!.id, T0, ISSUED_ON);

  assertEquals(issued.status, "issued");
  assertEquals(issued.issuedAt, T0);
  assertEquals(issued.snapshot?.subtotalMinor, 60_000);
  assertEquals(issued.snapshot?.entryIds, [entry.id], "11.23");

  // 11.8 -- editing the work afterwards does not reach through.
  updateEntry(db, entry.id, { durationMs: 40 * HOUR }, T0 + 1000);
  assertEquals(getInvoice(db, issued.id)?.snapshot?.subtotalMinor, 60_000);
  db.close();
});

Deno.test("25.11 -- work remembered after the draft was made does not join it", () => {
  // The inverse of what this used to assert. Issuing rebuilt from the entries, so four hours
  // remembered after the draft was drawn up appeared on it — convenient when the draft was only a
  // view of the work, and destructive once the draft is a document somebody has edited. The four
  // hours are not lost: 11.25 reports work that is on no invoice, which is where they surface.
  const db = fresh();
  work(db, "2026-09-01", 8);
  const draft = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(draft.draft.subtotalMinor, 60_000);

  work(db, "2026-09-02", 4);
  const issued = issue(db, draft.id, T0 + 5000, ISSUED_ON);
  assertEquals(issued.snapshot?.subtotalMinor, 60_000);
  db.close();
});

Deno.test("11.19/11.20/25.10 -- the second invoice for a month is refused at issuance, not before", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0, ISSUED_ON);

  // Creating is fine now: preparing a replacement while the wrong one is still issued is the
  // ordinary way to correct a mistake, and 25.10 says nothing earlier than issuance may refuse.
  const b = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(b.status, "draft");
  assertEquals(listInvoices(db).length, 2);

  // 11.19 bites here.
  assertThrows(() => issue(db, b.id, T0, ISSUED_ON), Refused, "already covered by");

  // And once the first is out of the way, the second goes through — which is 11.21's point about
  // reverting freeing the period, reached from the other direction.
  revertIssue(db, a.id, T0 + 1000);
  assertEquals(issue(db, b.id, T0 + 2000, ISSUED_ON).status, "issued");
  db.close();
});

Deno.test("11.21 -- reverting frees the period, and keeps the snapshot", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0, ISSUED_ON);

  const reverted = revertIssue(db, a.id, T0 + 1000);
  assertEquals(reverted.status, "draft");
  assertEquals(reverted.issuedAt, undefined);
  assertEquals(
    reverted.snapshot?.subtotalMinor,
    60_000,
    "11.18 -- what was sent to a client is not lost to a bookkeeping correction",
  );

  // ...and the period is free, so a fresh draft can be made and issued.
  const again = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0 + 2000);
  assertEquals(issue(db, again.id, T0 + 3000, ISSUED_ON).status, "issued");
  db.close();
});

Deno.test("11.9-11.12 -- paid, then unpaid, and only from the right state", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  assertThrows(() => markPaid(db, a.id, T0), Refused, "only an issued invoice");
  issue(db, a.id, T0, ISSUED_ON);
  const paid = markPaid(db, a.id, T0 + 1000);
  assertEquals(paid.status, "paid");
  assertEquals(paid.paidAt, T0 + 1000);
  assertEquals(paid.issuedAt, T0, "11.10 -- issuance time survives payment");

  assertThrows(() => markPaid(db, a.id, T0), Refused);
  const back = unmarkPaid(db, a.id, T0 + 2000);
  assertEquals(back.status, "issued");
  assertEquals(back.paidAt, undefined);
  assertThrows(() => unmarkPaid(db, a.id, T0), Refused, "is not paid");
  db.close();
});

Deno.test("a paid invoice says to unmark it before its issuance can be reverted", () => {
  // 11.14 -- corrective changes are explicit. Silently unmarking as part of a revert would be one
  // action doing two things, and the second one invisible.
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0, ISSUED_ON);
  markPaid(db, a.id, T0 + 1000);
  assertThrows(() => revertIssue(db, a.id, T0 + 2000), Refused, "unmark");
  db.close();
});

Deno.test("11.4 -- generating a PDF changes no accounting state", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  attachPdf(db, a.id, "invoices/INV-2026-09.pdf", T0 + 10);
  const after = getInvoice(db, a.id)!;
  assertEquals(after.status, "draft");
  assertEquals(after.pdfPath, "invoices/INV-2026-09.pdf");
  db.close();
});

Deno.test("a committed invoice is what invoiceForPeriod means, even beside a draft", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0, ISSUED_ON);
  // 11.22 permits a draft alongside; it is inserted directly because createDraft refuses.
  db.prepare(
    `INSERT INTO invoice (id, period, number, status, draft_json, created_at, updated_at)
     VALUES ('extra', '2026-09', 'INV-2026-09-B', 'draft', '{}', 0, 0)`,
  ).run();
  assertEquals(invoiceForPeriod(db, "2026-09")?.id, a.id);
  db.close();
});

Deno.test("acting on an invoice that does not exist is refused, not ignored", () => {
  const db = fresh();
  // `issue` takes the issuing device's day as well (27.51), so it is called on its own rather
  // than being made to fit a loop over functions that no longer share a signature.
  assertThrows(() => issue(db, "ghost", T0, ISSUED_ON), Refused, "no longer exists");
  for (const act of [markPaid, unmarkPaid, revertIssue]) {
    assertThrows(() => act(db, "ghost", T0), Refused, "no longer exists");
  }
  db.close();
});

Deno.test("tax and totals reach the stored draft, not just the calculation", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(a.draft.subtotalMinor, 60_000);
  assertEquals(a.draft.taxMinor, 6_000);
  assertEquals(a.draft.totalMinor, 66_000);
  assertEquals(a.draft.currency, "AUD");
  db.close();
});

Deno.test("24.31 -- what is missing is named, all of it, in one answer", () => {
  // One field per attempt, for a dozen fields, is a dozen attempts. The list is the point.
  const empty = missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, ...BLANK });
  assertEquals(empty.length > 8, true, `only found ${empty.join(", ")}`);
  assertEquals(empty.includes("your name"), true);
  assertEquals(empty.includes("the account number"), true);

  // 24.34 — the supplied format carries no ABN, so an absent one is not missing.
  assertEquals(missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, fromAbn: "" }), []);
  // Nor are the fields the renderer omits cleanly when unset.
  assertEquals(
    missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, approver: "", note: "", bonusMinor: 0 }),
    [],
  );
});

Deno.test("24.35 -- a tax needs a name only when there is a tax", () => {
  // "No tax applies" is a real configuration, and defaulting the label to GST asserted otherwise.
  assertEquals(missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, taxRate: 0, taxLabel: "" }), []);
  assertEquals(
    missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, taxRate: 0.1, taxLabel: "" }),
    ["a name for the tax"],
  );
});

Deno.test("a rate of zero is missing, not merely free", () => {
  assertEquals(
    missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, rateMinor: 0 }),
    ["an hourly rate above zero"],
  );
});

Deno.test("whitespace is not a value", () => {
  assertEquals(
    missingInvoiceConfig({ ...COMPLETE_INVOICE_CONFIG, clientName: "   " }),
    ["the client's name"],
  );
});

Deno.test("25.12 -- a draft can say something different from the settings, for itself alone", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  const b = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  // The configured rate is 0.1; this invoice is going somewhere that does not charge it.
  updateDraft(db, a.id, { config: { clientName: "Nightjar Analytics" }, taxRate: 0 }, T0);

  assertEquals(getInvoice(db, a.id)?.draft.config?.clientName, "Nightjar Analytics");
  assertEquals(getInvoice(db, a.id)?.draft.taxRate, 0);
  // ...for itself alone: the other draft and the global settings are untouched.
  assertEquals(getInvoice(db, b.id)?.draft.config, undefined);
  assertEquals(getInvoice(db, b.id)?.draft.taxRate, 0.1);
  assertEquals(getConfig(db, "invoice").clientName, "Kestrel Labs");
  db.close();
});

Deno.test("changing the tax rate moves the tax figure with it", () => {
  // The two have to move together. Storing the rate and leaving the old tax line would give a
  // document that disagrees with itself until some unrelated edit happened to recompute it.
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(a.draft.taxMinor, 6_000, "the configured 10% of 600.00");

  const taxed = updateDraft(db, a.id, { taxRate: 0.2 }, T0);
  assertEquals(taxed.draft.subtotalMinor, 60_000);
  assertEquals(taxed.draft.taxMinor, 12_000);
  assertEquals(taxed.draft.totalMinor, 72_000);

  const untaxed = updateDraft(db, a.id, { taxRate: 0 }, T0);
  assertEquals(untaxed.draft.taxMinor, 0);
  assertEquals(untaxed.draft.totalMinor, 60_000);
  db.close();
});

Deno.test("a tax rate that is really a percentage is refused", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  // 10 meaning "10%" would bill a thousand percent tax, silently. 25.3, with money attached.
  assertThrows(() => updateDraft(db, a.id, { taxRate: 10 }, T0), Refused, "not a fraction");
  assertThrows(() => updateDraft(db, a.id, { taxRate: -0.1 }, T0), Refused, "not a fraction");
  db.close();
});

Deno.test("25.12 -- a draft can be paid into somewhere else, and it does not travel", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  updateDraft(db, a.id, { paymentOverride: { payBsb: "999-999", payBank: "Another Bank" } }, T0);

  // The values are readable server-side, where the renderer needs them...
  assertEquals(paymentOverrideFor(db, a.id)?.payBsb, "999-999");
  assertEquals(paymentOverrideFor(db, a.id)?.payBank, "Another Bank");
  // ...and the record the handlers return says only that there is one.
  const record = getInvoice(db, a.id)!;
  assertEquals(record.paymentOverridden, true);
  assertEquals(JSON.stringify(record).includes("999-999"), false, "the BSB is on the wire");
  db.close();
});

Deno.test("an empty box leaves the stored payment override alone", () => {
  // The client cannot see what is there, so it cannot send it back unchanged; a blank has to mean
  // "leave it" or every save would wipe the fields it did not fill in.
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  updateDraft(db, a.id, { paymentOverride: { payBsb: "999-999", payBank: "Another Bank" } }, T0);
  updateDraft(db, a.id, { paymentOverride: { payBsb: "", payBank: "A Third Bank" } }, T0);

  assertEquals(paymentOverrideFor(db, a.id)?.payBsb, "999-999", "the blank cleared it");
  assertEquals(paymentOverrideFor(db, a.id)?.payBank, "A Third Bank");
  assertEquals(getInvoice(db, a.id)?.paymentOverridden, true);
  db.close();
});

Deno.test("and issuing freezes it, so a lost PDF still pays into the right place", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  updateDraft(db, a.id, { paymentOverride: { payAccountNumber: "11112222" } }, T0);
  issue(db, a.id, T0, ISSUED_ON);

  // 24.30 — what the renderer would be handed if the file went missing.
  assertEquals(frozenConfigFor(db, a.id)?.payAccountNumber, "11112222");
  // And the invoice's own settings, not the ones it inherited.
  assertEquals(frozenConfigFor(db, a.id)?.payBank, "Bank of Nowhere");
  db.close();
});

Deno.test("a period has to be a calendar month", () => {
  // `createDraft({ period: "banana" })` produced a draft with no lines and the number
  // `INV-banana`, which then sat in the list forever: it covers no month, so no work can ever
  // belong to it, and nothing reported it as wrong. The frontend only offers real months from a
  // `<select>`, which is exactly why nothing had noticed.
  const db = fresh();
  work(db, "2026-09-01", 8);
  for (const period of ["banana", "2026-13", "2026-0", "2026", "26-09", "2026-09-01"]) {
    assertThrows(
      () => createDraft(db, { period, preparedOn: "2026-10-01" }, T0),
      Refused,
      "not a calendar month",
    );
  }
  assertEquals(
    createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0).period,
    "2026-09",
  );
  db.close();
});

Deno.test("27.51 -- an invoice is dated where the person is, not where the server is", () => {
  /*
   * `issue()` called `today()` — the *server's* calendar day — for `invoiceDate` and for the due
   * date derived from it, and issuance is the moment those are frozen into the snapshot and the
   * PDF (10.8, 11.6). Its sibling three cases away, `invoice-create`, already takes the device's
   * `clock.today` for `preparedOn`, so the rule was settled and issuance did not follow it.
   *
   * A server in UTC and somebody in Sydney is not an exotic pairing — it is a container default
   * and a working morning. Every invoice issued before ten o'clock would carry yesterday's date
   * and a due date four weeks from yesterday.
   */
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", COMPLETE_INVOICE_CONFIG, T0);

  const draft = createDraft(db, { period: "2026-08", preparedOn: "2026-09-01" }, T0);
  // A day the server's clock is certainly not on.
  const issued = issue(db, draft.id, T0, "2027-03-04");

  assertEquals(issued.snapshot?.invoiceDate, "2027-03-04");
  // 10.2–10.4 — four weeks on, then forward to a Monday. 2027-04-01 is a Thursday.
  assertEquals(issued.snapshot?.dueDate, "2027-04-05");
  db.close();
});

/*
 * 9.9, 9.10 — a bonus set on one invoice appears on it, and the next month's starts from it.
 *
 * Every piece of this existed except the one a person uses: the PDF drew a bonus table, the server
 * carried the previous invoice's amount forward, and nothing on any screen could set one — so the
 * amount was always nought and the carry-forward carried nought. The seeder wrote a bonus straight
 * into the config, which is why every screenshot and the sample PDF showed one anyway. This drives
 * the path the draft editor now takes: an edit carrying a bonus line.
 */
Deno.test("9.9, 9.10 -- a bonus set on a draft is on it, and the next month starts from it", () => {
  const db = fresh();
  work(db, "2026-09-03", 2);
  const sept = createDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(sept.draft.bonusLine, null, "no bonus until somebody sets one");

  const edited = updateDraft(db, sept.id, { bonusLine: bonusLineFor(25_000) }, T0 + 1);
  assertEquals(edited.draft.bonusLine?.amountMinor, 25_000, "the edit put a bonus on the draft");
  assertEquals(edited.draft.bonusMinor, 25_000, "and the draft's bonus figure follows it");
  assertEquals(
    edited.draft.subtotalMinor,
    edited.draft.workSubtotalMinor + 25_000,
    "8.22 — the invoice total includes it and the work total does not",
  );

  work(db, "2026-10-02", 3);
  const oct = createDraft(db, { period: "2026-10", preparedOn: "2026-11-01" }, T0 + 2);
  assertEquals(oct.draft.bonusLine?.amountMinor, 25_000, "9.10 — the next invoice starts from it");

  const cleared = updateDraft(db, oct.id, { bonusLine: null }, T0 + 3);
  assertEquals(cleared.draft.bonusLine, null, "and it can be taken off again");
});

Deno.test("9.21 -- a bonus row with no Team/Project configured says General", () => {
  assertEquals(bonusLineFor(100, "")?.teamProject, "General", "the settings default is empty");
  assertEquals(bonusLineFor(100, "Retainer")?.teamProject, "Retainer");
  assertEquals(bonusLineFor(0, "Retainer"), null, "no amount is no row, not a zero row");
});
