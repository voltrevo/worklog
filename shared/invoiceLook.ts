/**
 * The invoice's palette, in one place, because two things have to look like each other.
 *
 * 26.16 asks the invoice settings to resemble the invoice they configure. A resemblance built by
 * eye is a resemblance that drifts the first time either side is touched — one navy in `pdf.ts`
 * and a different navy in a stylesheet look identical on the day they are written and not three
 * commits later. So the colours are shared rather than matched: `server/pdf.ts` hands these to
 * pdf-lib, and the settings form publishes them as custom properties. Neither side owns a colour.
 *
 * Kept as pdf-lib's 0–1 channels rather than as hex, because that is what the document renders
 * from: expressing them the other way round would round every colour in the PDF by up to 1/255 to
 * suit a stylesheet, which is the wrong way for the dependency to point.
 */

/** A colour, as pdf-lib wants it: three channels from 0 to 1. */
export type Channels = readonly [number, number, number];

export const INVOICE_PALETTE = {
  /** Body text. */
  ink: [0.13, 0.15, 0.18],
  /** Headings, and the total. */
  navy: [0.11, 0.22, 0.44],
  /** Labels, and anything the reader is not meant to stop on. */
  dim: [0.36, 0.40, 0.46],
  /** Hairlines between rows. */
  rule: [0.85, 0.87, 0.90],
  /** The highlight behind a value the document is asserting: the number, the date, the total. */
  amber: [0.996, 0.941, 0.816],
  /** The block holding who is being billed. */
  blueWash: [0.867, 0.918, 0.976],
  /** A table's column headings. */
  headWash: [0.804, 0.871, 0.957],
  /** The bonus row, which is not work and is coloured so it does not read as work. */
  bonusWash: [0.996, 0.973, 0.925],
  /** A table's own total row. */
  sumWash: [0.937, 0.957, 0.984],
} as const satisfies Record<string, Channels>;

export type InvoiceColour = keyof typeof INVOICE_PALETTE;

/** The same colour as CSS. Rounded, because a stylesheet has 8 bits per channel and cannot not be. */
export function cssColour(c: Channels): string {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${byte(c[0])} ${byte(c[1])} ${byte(c[2])})`;
}

/**
 * The palette as custom properties: `--inv-navy`, `--inv-head-wash`, and so on.
 *
 * Returned rather than written into the stylesheet so that the stylesheet cannot hold a stale copy
 * of a colour — the rules refer to the variables, and the variables come from here.
 */
export function invoiceCssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, channels] of Object.entries(INVOICE_PALETTE)) {
    const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out[`--inv-${kebab}`] = cssColour(channels);
  }
  return out;
}

/**
 * The document's own wording.
 *
 * Here for the same reason as the palette. 26.16 wants the settings form to resemble the invoice,
 * and the strongest available form of that is for the form to be captioned in the invoice's words
 * — not "Your ABN" beside a field whose value prints under "ABN:", which is a resemblance a reader
 * has to work out. `server/invoiceContent.ts` builds the document from these and the settings form
 * captions itself from them, so the two cannot disagree about what anything is called.
 *
 * The trailing colons are part of the document: they are what `Postal address:` looks like on the
 * page, and a form that drops them is already a different document.
 */
export const INVOICE_LABELS = {
  title: "INVOICE",
  from: {
    fromName: "Name (or name of company):",
    fromAddress: "Postal address:",
    fromPhone: "Telephone No.:",
    fromEmail: "E-mail address:",
    fromAbn: "ABN:",
  },
  identity: { number: "Inv. number", date: "Date" },
  billTo: "BILL TO:",
  period: "Time period:",
  workHeading: "DESCRIPTION OF WORK PERFORMED",
  columns: [
    "Date",
    "Description of work / expense",
    "Team/Project",
    "Hours",
    "Rate",
    "Amount",
  ],
  rowTotal: "Total",
  aside: { currency: "Hourly rate in:", approver: "Work Approver:" },
  subtotal: "Sub-total",
  /** What the tax row says when no rate is set, which is also what it says on an untaxed invoice. */
  noTax: "VAT (if applicable)",
  grandTotal: "TOTAL",
  paymentHeading: "METHOD OF PAYMENT",
  paymentMethod: "Payment request in:",
  account: {
    payName: "Name",
    payBsb: "BSB",
    payAccountNumber: "Account Number",
    payBank: "Bank",
  },
  due: "Payment due by",
} as const;
