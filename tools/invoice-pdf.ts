/**
 * Render one invoice to a file, so a person can look at it.
 *
 *     deno run -A --node-modules-dir=manual tools/invoice-pdf.ts ./data 2026-08 out.pdf
 *
 * `pdf_test.ts` can check every word on the page and none of its geometry — a PDF cannot be read
 * back, and "did it draw below the margin" is not a question a test can answer. This is the other
 * half: it takes a real database, renders a real period, and leaves a file to open.
 */

import { open } from "../server/db.ts";
import { getConfig } from "../server/config.ts";
import { invoiceForPeriod, saveDraft } from "../server/invoices.ts";
import { renderInvoicePdf } from "../server/pdf.ts";
import { today } from "../shared/dates.ts";

const [dataDir = "./data", period, out = "invoice.pdf"] = Deno.args;
if (!period) {
  console.error("usage: invoice-pdf.ts <dataDir> <YYYY-MM> [out.pdf]");
  Deno.exit(2);
}

const db = open({ path: `${dataDir}/worklog.sqlite` });
const invoice = invoiceForPeriod(db, period) ?? saveDraft(db, { period, preparedOn: today() });
// An issued invoice renders from its frozen snapshot, exactly as the server does (11.6, 11.8).
const bytes = await renderInvoicePdf(invoice.snapshot ?? invoice.draft, getConfig(db, "invoice"));
await Deno.writeFile(out, bytes);

console.log(
  `${out}: ${invoice.number}, ${invoice.status}, ${invoice.draft.lines.length} work rows, ` +
    `${(bytes.length / 1024).toFixed(1)} kB`,
);
db.close();
