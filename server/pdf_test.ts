/**
 * The invoice's words, asserted exactly; its geometry, asserted only where a failure is silent.
 *
 * A PDF cannot be read back — `pdf-lib` compresses its content streams, so scanning the bytes for a
 * string finds nothing and a test built that way passes whatever it is asked. The first version of
 * this file did exactly that and "proved" the page contained no placeholders. `invoiceContent`
 * exists so that the words can be checked without the renderer, and what remains here about the PDF
 * itself is the page count, because drawing below the margin does not throw.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { PDFDocument } from "pdf-lib";
import { buildDraft } from "@worklog/shared/invoice";
import { DEFAULTS, type InvoiceConfig } from "./config.ts";
import { allText, formatDate, invoiceContent, money, periodRange } from "./invoiceContent.ts";
import { renderInvoicePdf, renderInvoicePdfChecked } from "./pdf.ts";

const HOUR = 3_600_000;

const CONFIG: InvoiceConfig = {
  ...DEFAULTS.invoice,
  fromName: "Wren & Co",
  fromAddress: "12 Fictional Way, Nowhere NSW 2000, Australia",
  fromEmail: "hello@example.invalid",
  fromPhone: "+61 400 000 000",
  fromAbn: "00 000 000 000",
  clientName: "Kestrel Labs Pty Ltd",
  clientAddress: "1 Imaginary Street, Level 9\nMelbourne VIC 3000\nAustralia",
  currency: "AUD",
  rateMinor: 12_000,
  approver: "Robin Fairweather",
  teamProject: "Product Development",
  payName: "Wren & Co",
  payBsb: "000-000",
  payAccountNumber: "00000000",
  payBank: "Bank of Nowhere",
};

function draftWith(lines: number, bonusMinor = 0, over: Record<string, unknown> = {}) {
  return buildDraft({
    period: "2026-08",
    /*
     * `lines` really is the number of lines.
     *
     * It used to be the number of *entries*, and `buildLines` aggregates by date and tag — with
     * one tag and dates cycling over 28 days, every value above 28 produced exactly 28 rows.
     * `draftWith(100)` and `draftWith(28)` were the same document, so "a long month spills onto a
     * second page" was the largest invoice this suite could describe, and everything past the
     * first page break had never been rendered at all.
     *
     * The tag varies once the dates run out, so the rows stay distinct. Below 28 nothing changes,
     * which is every other caller.
     */
    entries: Array.from({ length: lines }, (_, i) => ({
      id: `e${i}`,
      date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      durationMs: 7.5 * HOUR,
      billingTag: i < 28 ? "Feature development" : `Feature development ${Math.floor(i / 28)}`,
    })),
    teamProject: "Product Development",
    rateMinor: 12_000,
    bonusMinor,
    currency: "AUD",
    taxRate: 0,
    preparedOn: "2026-09-05",
    ...over,
  });
}

// ------------------------------------------------------------------ formatting

Deno.test("money is grouped, two-decimal and symbol-first, whatever the locale is", () => {
  // Not `Intl`: a server in another locale would print a different invoice from the same numbers,
  // and this is a document somebody keeps.
  assertEquals(money(106_003, "AUD"), "$ 1,060.03");
  assertEquals(money(0, "AUD"), "$ 0.00");
  assertEquals(money(5, "AUD"), "$ 0.05");
  assertEquals(money(123_456_789, "USD"), "$ 1,234,567.89");
  assertEquals(money(-2_500, "AUD"), "-$ 25.00");
  assertEquals(money(2_500, "SEK"), "SEK 25.00", "an unknown currency uses its code");
});

Deno.test("a date is formatted from its parts, so no timezone can move it", () => {
  // `new Date("2026-08-01")` is UTC midnight, which prints as 31 July anywhere west of Greenwich.
  assertEquals(formatDate("2026-08-01"), "1 Aug 2026");
  assertEquals(formatDate("2026-12-31"), "31 Dec 2026");
  assertEquals(formatDate("2026-01-01"), "1 Jan 2026");
});

Deno.test("the period range covers the whole month, leap years included", () => {
  assertEquals(periodRange("2026-08"), "1 - 31 Aug 2026");
  assertEquals(periodRange("2026-09"), "1 - 30 Sep 2026");
  assertEquals(periodRange("2026-02"), "1 - 28 Feb 2026");
  assertEquals(periodRange("2028-02"), "1 - 29 Feb 2028");
});

// ------------------------------------------------------------------ what the page says

Deno.test("8.6-8.14 -- every part the format requires is on the page", () => {
  const c = invoiceContent(draftWith(3, 25_000), CONFIG);
  const words = allText(c).join("\n");

  assertStringIncludes(words, "Wren & Co"); // 8.6, 8.23
  assertStringIncludes(words, "Telephone No.:");
  assertStringIncludes(words, "Kestrel Labs Pty Ltd"); // 8.7
  assertStringIncludes(words, "1 - 31 Aug 2026"); // 8.8
  assertStringIncludes(words, "DESCRIPTION OF WORK PERFORMED"); // 8.27
  assertStringIncludes(words, "Description of work / expense"); // 8.10
  assertStringIncludes(words, "Team/Project");
  assertStringIncludes(words, "Sub-total"); // 8.11
  assertStringIncludes(words, "VAT (if applicable)");
  assertStringIncludes(words, "TOTAL");
  assertStringIncludes(words, "Robin Fairweather"); // 8.12
  assertStringIncludes(words, "METHOD OF PAYMENT"); // 8.13, 8.30
  assertStringIncludes(words, "Bank of Nowhere");
  assertStringIncludes(words, "Payment due by"); // 8.14, 8.31
  assertStringIncludes(words, "5 Oct 2026"); // four weeks from 5 Sep, then Monday
});

Deno.test("8.19-8.21 -- the bonus row covers the period and carries its own Team/Project", () => {
  const c = invoiceContent(draftWith(3, 25_000, { bonusTeamProject: "General" }), CONFIG);
  assertEquals(c.bonusRow, [
    "1 - 31 Aug 2026",
    "Monthly bonus",
    "General",
    "-",
    "-",
    "$ 250.00",
  ]);
  assertEquals(c.bonusSubtotal, "$ 250.00");
  assertEquals(c.rows.every((r) => r[2] === "Product Development"), true);
});

Deno.test("8.22 -- the work Total excludes the bonus, and the invoice total includes it", () => {
  const c = invoiceContent(draftWith(4, 25_000), CONFIG);
  assertEquals(c.totalRow, ["", "", "Total", "30.0", "", "$ 3,600.00"]);
  assertEquals(c.totals.map((t) => t.value), ["$ 3,850.00", "$ 0.00", "$ 3,850.00"]);
});

Deno.test("no bonus means no bonus table at all, rather than a zero row", () => {
  const c = invoiceContent(draftWith(2), CONFIG);
  assertEquals(c.bonusRow, undefined);
  assertEquals(c.bonusSubtotal, undefined);
});

Deno.test("9.4/20.9 -- an unset field is absent from the page, not a placeholder", () => {
  // The check the byte-scanning version could not actually make: with nothing configured, no
  // label whose value is missing appears, and nothing invented does either.
  const c = invoiceContent(draftWith(2), DEFAULTS.invoice);
  const words = allText(c);

  for (const absent of ["Name (or name of company):", "Telephone No.:", "Work Approver:", "Bank"]) {
    assertEquals(words.includes(absent), false, `"${absent}" printed with nothing beside it`);
  }
  assertEquals(c.billTo, [], "no client, so no bill-to block");
  assertEquals(c.account, [], "no account details, so no rows");

  for (const ghost of ["undefined", "null", "NaN", "TODO", "example.com", "[object Object]"]) {
    assertEquals(words.some((w) => w.includes(ghost)), false, `the page contains "${ghost}"`);
  }
  // ...and what is genuinely known is still there.
  assertStringIncludes(words.join("\n"), "INV-2026-08");
});

Deno.test("a tax rate replaces the VAT placeholder with the configured label", () => {
  const c = invoiceContent(draftWith(2, 0, { taxRate: 0.1 }), { ...CONFIG, taxLabel: "GST" });
  assertEquals(c.totals[1]?.label, "GST (10%)");
  const odd = invoiceContent(draftWith(2, 0, { taxRate: 0.125 }), { ...CONFIG, taxLabel: "GST" });
  assertEquals(odd.totals[1]?.label, "GST (12.5%)");
});

// ------------------------------------------------------------------ the document

Deno.test("a small invoice renders to one page of real PDF", async () => {
  const bytes = await renderInvoicePdf(draftWith(6), CONFIG);
  assertStringIncludes(new TextDecoder().decode(bytes.slice(0, 8)), "%PDF-");
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
});

Deno.test("a long month spills onto a second page rather than off the first", async () => {
  // Getting this wrong does not throw -- it draws below the margin, off the paper, where nobody
  // notices until the invoice has been sent.
  const bytes = await renderInvoicePdf(draftWith(28, 25_000), CONFIG);
  assertEquals((await PDFDocument.load(bytes)).getPageCount() >= 2, true);
});

Deno.test("an unconfigured invoice still renders", async () => {
  const bytes = await renderInvoicePdf(draftWith(2), DEFAULTS.invoice);
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
});

Deno.test("an invoice with no work at all renders, because a bonus-only month is a real one", async () => {
  const bytes = await renderInvoicePdf(draftWith(0, 25_000), CONFIG);
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
});

Deno.test("25.18 -- the payment method is printed as configured", () => {
  const c = invoiceContent(draftWith(3, 25_000), CONFIG);
  // It used to be `${currency} (${payMethod})` -- "AUD (Wire Transfer)" -- which reads as the
  // currency with the method as an afterthought. The currency is already on "Hourly rate in" two
  // lines above; what a client needs on this line is how to send the money.
  assertEquals(c.paymentMethod.value, CONFIG.payMethod);
  assertEquals(c.paymentMethod.value.includes("("), false);
  assertEquals(c.paymentMethod.value.includes(CONFIG.currency), false);
});

Deno.test("25.7 -- the totals on the page are the sum of the lines on the page", () => {
  // Read off the rendered content rather than the draft, because the claim is about the document:
  // whatever the arithmetic did, a client adding up the Amount column must reach the Sub-total.
  const c = invoiceContent(draftWith(17, 25_000), CONFIG);
  const cents = (s: string) => Math.round(Number(s.replace(/[^0-9.-]/g, "")) * 100);
  const rows = c.rows.reduce((t, r) => t + cents(r[5]!), 0);
  assertEquals(cents(c.totalRow[5]!), rows);
  // And the Hours column adds up to the Total hours cell beside it.
  const hours = c.rows.reduce((t, r) => t + Number(r[3]), 0);
  assertEquals(Number(c.totalRow[3]), Math.round(hours * 10) / 10);
});

Deno.test("25.12 -- a draft's own settings are what the document prints", () => {
  const draft = draftWith(3, 25_000);
  const overridden = {
    ...draft,
    config: { clientName: "Nightjar Analytics", approver: "Wren Delacroix" },
  };
  const words = allText(invoiceContent(overridden, CONFIG)).join("\n");

  assertStringIncludes(words, "Nightjar Analytics");
  assertStringIncludes(words, "Wren Delacroix");
  // ...and only what it said differently. Everything else still comes from the settings, which is
  // what makes an override a short list of exceptions rather than a stale second copy.
  assertEquals(words.includes(CONFIG.clientName), false);
  assertStringIncludes(words, CONFIG.fromName);
});

Deno.test("an override left blank falls through rather than printing empty", () => {
  // `{...config, ...{clientName: ""}}` is a nameless client, which is not what an empty box means.
  const draft = { ...draftWith(3, 25_000), config: { clientName: "  ", approver: "" } };
  const words = allText(invoiceContent(draft, CONFIG)).join("\n");
  assertStringIncludes(words, CONFIG.clientName);
  assertStringIncludes(words, CONFIG.approver);
});

Deno.test("nothing is drawn outside the margins, however awkward the content", async () => {
  /*
   * Every column width in `pdf.ts` is a number chosen against the fixture, and the fixture is
   * polite: "Wren & Co", "Product Development". Given a real trading name the from-block printed
   * *through* the invoice-number box, and given a sentence in the note — a free-text field, where
   * a sentence is the ordinary thing to put — the note started at a negative x and ran off both
   * edges of the page, over the payment method on its way.
   *
   * Neither threw. Neither was caught by anything here. Both produce a document somebody sends to
   * a client, and the only way either was found was rendering one and looking at it.
   *
   * So: awkward values in every free-text field at once, and the renderer reports what it had to
   * put outside its own margins.
   */
  const long = "Platform reliability, observability and incident response retrospective work";
  const unbroken = "ReconciliationOfQuarterlySubcontractorInvoicingAndDisbursements";
  const draft = draftWith(3, 25_000);
  const { outside } = await renderInvoicePdfChecked({
    ...draft,
    lines: draft.lines.map((l, i) => ({ ...l, description: i === 0 ? long : unbroken })),
  }, {
    ...CONFIG,
    fromName: "Wren Consulting and Associated Reliability Engineering Services Pty Limited",
    clientName: `${unbroken} Holdings Pty Ltd`,
    approver: "Wren Alexandra Fairweather-Montgomery III",
    note:
      "This invoice covers work performed under the master services agreement dated the first of " +
      "January, and is payable within twenty-eight days of the date shown above.",
    teamProject: long,
  });

  assertEquals(outside, []);
});

Deno.test("and the check can see an overflow when there is one", async () => {
  // Otherwise the test above passes by the renderer never looking. A note this long cannot fit
  // the half-width column it is given, and one word of it has nowhere to break.
  const { outside } = await renderInvoicePdfChecked(draftWith(1, 0), {
    ...CONFIG,
    note: "x".repeat(400),
  });
  assertEquals(outside.length > 0, true, "a 400-character unbroken note fitted the page");
});

Deno.test("a very long month paginates rather than piling up at the bottom", async () => {
  /*
   * 28 lines proves there is a second page. It does not prove there is a third, and "spills onto
   * a second page" is the kind of claim that holds for exactly one page break — a `y` that is
   * reset once at the top of a new page and then never checked again looks correct on the only
   * case anybody tried.
   *
   * A hundred lines is more than a month of work can produce, which is the point: the bound is
   * the paper, not the plausible.
   */
  const bytes = await renderInvoicePdf(draftWith(100, 25_000), CONFIG);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  assertEquals(pages >= 4, true, `100 lines fitted ${pages} page(s)`);

  // And nothing was drawn off the sides on any of them.
  const { outside } = await renderInvoicePdfChecked(draftWith(100, 25_000), CONFIG);
  assertEquals(outside, []);
});
