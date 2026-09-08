/**
 * Shared test fixtures.
 *
 * `COMPLETE_INVOICE_CONFIG` exists because 24.31 makes an incomplete configuration a refusal, so
 * every test that produces an invoice now needs a whole one. Defined once: a dozen fields copied
 * into each test file drift, and the drift shows up as a refusal in a test about something else.
 *
 * Every value is fictional (20.7, 9.4). There is no such firm, no such client and no such bank,
 * the BSB is not a real one and the account number is a run of zeros — this file is committed to a
 * repository that may be public, and a fixture that looks like real banking detail is a fixture
 * somebody will eventually mistake for some.
 */

import type { InvoiceConfig } from "./config.ts";

export const COMPLETE_INVOICE_CONFIG: InvoiceConfig = {
  fromName: "A Fictional Contractor",
  fromAddress: "1 Imaginary Street, Nowhere",
  fromEmail: "nobody@example.invalid",
  fromAbn: "",
  fromPhone: "+61 400 000 000",
  clientName: "Invented Client Pty Ltd",
  clientAddress: "2 Notional Avenue, Elsewhere",
  currency: "AUD",
  rateMinor: 7500,
  taxRate: 0,
  taxLabel: "",
  approver: "",
  teamProject: "Research",
  bonusMinor: 0,
  bonusTeamProject: "",
  note: "",
  payMethod: "Wire Transfer",
  payName: "A Fictional Contractor",
  payBsb: "000-000",
  payAccountNumber: "00000000",
  payBank: "Bank of Nowhere",
};
