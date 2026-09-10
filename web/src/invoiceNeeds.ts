/**
 * What an invoice still needs, from what a device is allowed to know (27.11).
 *
 * The authority is `missingInvoiceConfig` on the server, which sees the payment values and refuses
 * to render a document without them (24.31). A device sees only whether each hidden group holds
 * anything, so this cannot be the same function — but it can name the same things in the same
 * words, and both screens that ask the question can ask it here.
 *
 * The Settings card asks about a *draft* it is holding, so it passes what has been typed rather
 * than what is stored; the invoices list asks about what is saved. Same list either way.
 */

import type { PublicInvoiceConfig } from "@worklog/shared/protocol";

export function invoiceNeeds(cfg: PublicInvoiceConfig): string[] {
  return [
    !cfg.fromName.trim() && "your name or trading name",
    !cfg.addressSet && "your address",
    !cfg.clientName.trim() && "the client's name",
    !cfg.clientAddress.trim() && "the client's address",
    !cfg.currency.trim() && "a currency",
    !cfg.teamProject.trim() && "a team or project",
    !(cfg.rateMinor > 0) && "an hourly rate",
    !cfg.paymentDetailsSet && "payment details",
  ].filter((x) => typeof x === "string");
}

/** The same list as a sentence, since both callers write one. */
export function needsSentence(needs: string[]): string {
  return `An invoice still needs ${needs.join(", ")}.`;
}
