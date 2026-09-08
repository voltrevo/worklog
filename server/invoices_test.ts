import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { type Db, open } from "./db.ts";
import { setConfig } from "./config.ts";
import { addEntry, Refused, updateEntry } from "./work.ts";
import {
  attachPdf,
  getInvoice,
  invoiceForPeriod,
  issue,
  listInvoices,
  markPaid,
  revertIssue,
  saveDraft,
  unmarkPaid,
} from "./invoices.ts";

const HOUR = 3_600_000;
const T0 = 1_788_000_000_000;

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

Deno.test("a draft is built from the work as it stands, and rebuilding keeps its identity", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const first = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(first.status, "draft");
  assertEquals(first.number, "INV-2026-09");
  assertEquals(first.draft.subtotalMinor, 60_000);

  work(db, "2026-09-02", 2);
  const second = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0 + 1000);
  assertEquals(second.id, first.id, "the same invoice, not a new one");
  assertEquals(second.draft.subtotalMinor, 75_000);
  assertEquals(listInvoices(db).length, 1);
  db.close();
});

Deno.test("9.8/9.10/9.13 -- Team/Project and bonus default from the previous period", () => {
  const db = fresh();
  work(db, "2026-08-03", 8);
  saveDraft(db, {
    period: "2026-08",
    teamProject: "Client Onboarding",
    bonusMinor: 25_000,
    preparedOn: "2026-09-01",
  }, T0);

  work(db, "2026-09-01", 8);
  const sept = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(sept.draft.teamProject, "Client Onboarding");
  assertEquals(sept.draft.bonusMinor, 25_000);
  assertEquals(sept.draft.bonusLine?.description, "Monthly bonus", "8.19 -- in its own table");
  db.close();
});

Deno.test("the seed config is used when there is no previous invoice", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const first = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(first.draft.teamProject, "Protocol Research");
  assertEquals(first.draft.bonusMinor, 0);
  db.close();
});

Deno.test("11.6 -- issuing freezes the work as it is at that moment", () => {
  const db = fresh();
  const entry = work(db, "2026-09-01", 8);
  saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  const issued = issue(db, invoiceForPeriod(db, "2026-09")!.id, T0);

  assertEquals(issued.status, "issued");
  assertEquals(issued.issuedAt, T0);
  assertEquals(issued.snapshot?.subtotalMinor, 60_000);
  assertEquals(issued.snapshot?.entryIds, [entry.id], "11.23");

  // 11.8 -- editing the work afterwards does not reach through.
  updateEntry(db, entry.id, { durationMs: 40 * HOUR }, T0 + 1000);
  assertEquals(getInvoice(db, issued.id)?.snapshot?.subtotalMinor, 60_000);
  db.close();
});

Deno.test("issuing rebuilds first, so a preview from an hour ago is not what gets frozen", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const draft = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(draft.draft.subtotalMinor, 60_000);

  work(db, "2026-09-02", 4); // remembered after the preview
  const issued = issue(db, draft.id, T0 + 5000);
  assertEquals(issued.snapshot?.subtotalMinor, 90_000);
  db.close();
});

Deno.test("11.19/11.20 -- a second invoice for the same month cannot be issued", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0);

  assertThrows(
    () => saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0),
    Refused,
    "has been issued",
  );
  db.close();
});

Deno.test("11.21 -- reverting frees the period, and keeps the snapshot", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0);

  const reverted = revertIssue(db, a.id, T0 + 1000);
  assertEquals(reverted.status, "draft");
  assertEquals(reverted.issuedAt, undefined);
  assertEquals(
    reverted.snapshot?.subtotalMinor,
    60_000,
    "11.18 -- what was sent to a client is not lost to a bookkeeping correction",
  );

  // ...and the period is free, so a fresh draft can be made and issued.
  const again = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0 + 2000);
  assertEquals(issue(db, again.id, T0 + 3000).status, "issued");
  db.close();
});

Deno.test("11.9-11.12 -- paid, then unpaid, and only from the right state", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);

  assertThrows(() => markPaid(db, a.id, T0), Refused, "only an issued invoice");
  issue(db, a.id, T0);
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
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0);
  markPaid(db, a.id, T0 + 1000);
  assertThrows(() => revertIssue(db, a.id, T0 + 2000), Refused, "unmark");
  db.close();
});

Deno.test("11.4 -- generating a PDF changes no accounting state", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  attachPdf(db, a.id, "invoices/INV-2026-09.pdf", T0 + 10);
  const after = getInvoice(db, a.id)!;
  assertEquals(after.status, "draft");
  assertEquals(after.pdfPath, "invoices/INV-2026-09.pdf");
  db.close();
});

Deno.test("a committed invoice is what invoiceForPeriod means, even beside a draft", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  issue(db, a.id, T0);
  // 11.22 permits a draft alongside; it is inserted directly because saveDraft refuses.
  db.prepare(
    `INSERT INTO invoice (id, period, number, status, draft_json, created_at, updated_at)
     VALUES ('extra', '2026-09', 'INV-2026-09-B', 'draft', '{}', 0, 0)`,
  ).run();
  assertEquals(invoiceForPeriod(db, "2026-09")?.id, a.id);
  db.close();
});

Deno.test("acting on an invoice that does not exist is refused, not ignored", () => {
  const db = fresh();
  for (const act of [issue, markPaid, unmarkPaid, revertIssue]) {
    assertThrows(() => act(db, "ghost", T0), Refused, "no invoice");
  }
  db.close();
});

Deno.test("tax and totals reach the stored draft, not just the calculation", () => {
  const db = fresh();
  work(db, "2026-09-01", 8);
  const a = saveDraft(db, { period: "2026-09", preparedOn: "2026-10-01" }, T0);
  assertEquals(a.draft.subtotalMinor, 60_000);
  assertEquals(a.draft.taxMinor, 6_000);
  assertEquals(a.draft.totalMinor, 66_000);
  assertEquals(a.draft.currency, "AUD");
  db.close();
});
