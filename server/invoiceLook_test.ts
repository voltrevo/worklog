/**
 * 26.16 — the document prints the words the settings screen captions itself with.
 *
 * `shared/invoiceLook.ts` exists so that the form configuring an invoice can be captioned in the
 * invoice's own vocabulary rather than in a parallel one — "ABN:" over the field whose value prints
 * under "ABN:", instead of "Your ABN" beside it. That only holds while the renderer actually uses
 * them, and a label can stop reaching the page in two quiet ways: the renderer starts writing its
 * own string again, or a section stops being rendered at all.
 *
 * So: build a document that exercises every section, and check each of them arrives in its
 * content. Content and not rendered bytes, for the reason `pdf_test.ts` opens with — pdf-lib
 * compresses its streams, so a test that scans the file for a string finds nothing and passes
 * whatever it is given. `invoiceContent` is the seam where the words are still words.
 */

import { assert } from "jsr:@std/assert@^1";
import { buildDraft } from "@worklog/shared/invoice";
import { INVOICE_LABELS } from "@worklog/shared/invoiceLook";
import { DEFAULTS, type InvoiceConfig } from "./config.ts";
import { allText, invoiceContent } from "./invoiceContent.ts";

const HOUR = 3_600_000;

/** Filled in, because `invoiceContent` drops a pair whose value is blank — as 9.4 requires. */
const CONFIG: InvoiceConfig = {
  ...DEFAULTS.invoice,
  fromName: "Wren & Co",
  fromAddress: "12 Fictional Way, Nowhere NSW 2000",
  fromEmail: "hello@example.invalid",
  fromPhone: "+61 400 000 000",
  fromAbn: "00 000 000 000",
  clientName: "Kestrel Labs Pty Ltd",
  clientAddress: "1 Imaginary Street\nMelbourne VIC 3000",
  currency: "AUD",
  rateMinor: 12_000,
  approver: "Robin Fairweather",
  teamProject: "Product Development",
  taxLabel: "GST",
  payMethod: "Bank transfer",
  payName: "Wren & Co",
  payBsb: "000-000",
  payAccountNumber: "00000000",
  payBank: "Bank of Nowhere",
};

function everySection() {
  return invoiceContent(
    buildDraft({
      period: "2026-08",
      entries: [{
        id: "e1",
        date: "2026-08-03",
        durationMs: 7.5 * HOUR,
        billingTag: "Feature development",
      }],
      teamProject: CONFIG.teamProject,
      bonusTeamProject: CONFIG.bonusTeamProject,
      // A bonus, so the bonus table renders; a tax rate, so the tax row is a rate and not the
      // "(if applicable)" placeholder. Both are the branch the plain case does not reach.
      bonusMinor: 25_000,
      taxRate: 0.1,
      rateMinor: CONFIG.rateMinor,
      currency: CONFIG.currency,
      number: "INV-2026-08",
      preparedOn: "2026-09-09",
    }),
    CONFIG,
  );
}

/** Every string in the module, however deep, since each of them is a caption on the page. */
function captions(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(captions);
  if (value && typeof value === "object") return Object.values(value).flatMap(captions);
  return [];
}

Deno.test("26.16 — every caption in invoiceLook reaches the document", () => {
  const words = allText(everySection());
  const absent = captions(INVOICE_LABELS)
    // The tax row prints its rate in brackets after the label, and prints `noTax` only when there
    // is no rate — the two are alternatives, so one of them is always missing by design.
    .filter((c) => c !== INVOICE_LABELS.noTax)
    .filter((c) => !words.includes(c));
  assert(absent.length === 0, `not on the page: ${absent.join(", ")}`);
});

Deno.test("26.16 — and the untaxed invoice says the other one", () => {
  const content = invoiceContent(
    buildDraft({
      period: "2026-08",
      entries: [],
      teamProject: CONFIG.teamProject,
      bonusTeamProject: CONFIG.bonusTeamProject,
      bonusMinor: 0,
      taxRate: 0,
      rateMinor: CONFIG.rateMinor,
      currency: CONFIG.currency,
      number: "INV-2026-08",
      preparedOn: "2026-09-09",
    }),
    CONFIG,
  );
  assert(allText(content).includes(INVOICE_LABELS.noTax));
});
