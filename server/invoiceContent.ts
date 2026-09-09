/**
 * Everything the invoice *says*, decided before anything is drawn.
 *
 * Split out from the renderer because a PDF cannot be read back. `pdf-lib` compresses its content
 * streams, so a test that scans the bytes for a string finds nothing and passes whatever it was
 * asked — which is exactly what the first version of `pdf_test.ts` did when it asserted the page
 * contained no placeholders. An oracle that cannot disagree is not one.
 *
 * So the words are a pure function of the draft and the configuration, and `pdf.ts` is geometry:
 * where each of these strings goes. The content can then be asserted exactly, and the renderer's
 * remaining risk is layout — which is what a person looking at the page is for.
 */

import type { InvoiceDraft } from "@worklog/shared/invoice";
import type { DateString } from "@worklog/shared/types";
import type { InvoiceConfig } from "./config.ts";

export interface Pair {
  label: string;
  value: string;
}

export interface InvoiceContent {
  /** 8.23 — the sender. Only fields that are set; an empty one is absent, not blank (9.4, 20.9). */
  from: Pair[];
  /** 8.24 */
  identity: Pair[];
  /** 8.7, 8.25 — the first line is the client's name, the rest the address. */
  billTo: string[];
  /** 8.8, 8.26 */
  period: Pair;
  heading: string;
  columns: string[];
  /** 8.19–8.21 — six cells, or absent when there is no bonus. */
  bonusRow?: string[];
  bonusSubtotal?: string;
  /** 8.9, 8.10 */
  rows: string[][];
  /** 8.22 — the work table's own Total, as its six cells. */
  totalRow: string[];
  /** 8.28 */
  aside: Pair[];
  /** 8.11, 8.29 */
  totals: Pair[];
  /** 8.30 */
  paymentHeading: string;
  paymentMethod: Pair;
  /** 8.32 */
  note?: string;
  account: Pair[];
  /** 8.14, 8.31 */
  due: Pair;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A date formatted from its parts, never through `new Date(iso)`.
 *
 * That constructor reads a bare `YYYY-MM-DD` as UTC midnight, so a server west of Greenwich would
 * print the day before on every line — the same trap the UI avoids in `format.ts` and the schema
 * avoids by storing a date rather than an instant.
 */
export function formatDate(date: DateString): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function periodRange(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `1 - ${last} ${MONTHS[m - 1]} ${y}`;
}

/**
 * `$ 1,060.03`, laid out the way the format does rather than by `Intl`.
 *
 * `Intl` would print a different invoice from the same numbers depending on the server's locale,
 * and this is a document somebody keeps.
 */
export function money(minor: number, currency: string): string {
  const negative = minor < 0;
  const whole = Math.floor(Math.abs(minor) / 100);
  const cents = String(Math.abs(minor) % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${SYMBOLS[currency] ?? `${currency} `}${grouped}.${cents}`;
}

const SYMBOLS: Record<string, string> = {
  AUD: "$ ",
  USD: "$ ",
  NZD: "$ ",
  CAD: "$ ",
  EUR: "€ ",
  GBP: "£ ",
};

function pct(rate: number): string {
  const value = rate * 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** Keep the pairs whose value is set. This is where 9.4's "no invented data" actually happens. */
function set(pairs: Array<[string, string]>): Pair[] {
  return pairs.filter(([, v]) => v.trim().length > 0).map(([label, value]) => ({ label, value }));
}

export function invoiceContent(draft: InvoiceDraft, config: InvoiceConfig): InvoiceContent {
  const cur = draft.currency;

  const content: InvoiceContent = {
    from: set([
      ["Name (or name of company):", config.fromName],
      ["Postal address:", config.fromAddress],
      ["Telephone No.:", config.fromPhone],
      ["E-mail address:", config.fromEmail],
      ["ABN:", config.fromAbn],
    ]),
    identity: [
      { label: "Inv. number", value: draft.number },
      { label: "Date", value: formatDate(draft.invoiceDate) },
    ],
    billTo: [config.clientName, ...config.clientAddress.split("\n")]
      .map((l) => l.trim())
      .filter(Boolean),
    period: { label: "Time period:", value: periodRange(draft.period) },
    heading: "DESCRIPTION OF WORK PERFORMED",
    columns: [
      "Date",
      "Description of work / expense",
      "Team/Project",
      "Hours",
      "Rate",
      "Amount",
    ],
    rows: draft.lines.map((l) => [
      l.date ? formatDate(l.date) : "",
      l.description,
      l.teamProject,
      l.hours === null ? "-" : l.hours.toFixed(1),
      l.rateMinor === null ? "-" : money(l.rateMinor, cur),
      money(l.amountMinor, cur),
    ]),
    totalRow: [
      "",
      "",
      "Total",
      draft.workHours.toFixed(1),
      "",
      money(draft.workSubtotalMinor, cur),
    ],
    aside: set([
      ["Hourly rate in:", cur],
      ["Work Approver:", config.approver],
    ]),
    totals: [
      { label: "Sub-total", value: money(draft.subtotalMinor, cur) },
      {
        label: draft.taxRate > 0
          ? `${config.taxLabel} (${pct(draft.taxRate)})`
          : "VAT (if applicable)",
        value: money(draft.taxMinor, cur),
      },
      { label: "TOTAL", value: money(draft.totalMinor, cur) },
    ],
    paymentHeading: "METHOD OF PAYMENT",
    paymentMethod: {
      label: "Payment request in:",
      // 25.18 — verbatim. It used to print `AUD (Bank transfer)`, which reads as the currency with
      // the method as a parenthetical afterthought; the currency is already stated two lines up on
      // "Hourly rate in", and what the client needs here is how to pay.
      value: config.payMethod,
    },
    account: set([
      ["Name", config.payName],
      ["BSB", config.payBsb],
      ["Account Number", config.payAccountNumber],
      ["Bank", config.payBank],
    ]),
    due: { label: "Payment due by", value: formatDate(draft.dueDate) },
  };

  if (draft.bonusLine) {
    content.bonusRow = [
      // 8.20 — the row covers the period, so its Date cell says so rather than naming a day.
      periodRange(draft.period),
      draft.bonusLine.description,
      draft.bonusLine.teamProject,
      "-",
      "-",
      money(draft.bonusLine.amountMinor, cur),
    ];
    content.bonusSubtotal = money(draft.bonusLine.amountMinor, cur);
  }
  if (config.note.trim()) content.note = config.note.trim();

  return content;
}

/** Every string that will be drawn, for a test that wants to know what is on the page. */
export function allText(content: InvoiceContent): string[] {
  return [
    ...content.from.flatMap((p) => [p.label, p.value]),
    ...content.identity.flatMap((p) => [p.label, p.value]),
    ...content.billTo,
    content.period.label,
    content.period.value,
    content.heading,
    ...content.columns,
    ...(content.bonusRow ?? []),
    ...(content.bonusSubtotal ? [content.bonusSubtotal] : []),
    ...content.rows.flat(),
    ...content.totalRow,
    ...content.aside.flatMap((p) => [p.label, p.value]),
    ...content.totals.flatMap((p) => [p.label, p.value]),
    content.paymentHeading,
    content.paymentMethod.label,
    content.paymentMethod.value,
    ...(content.note ? [content.note] : []),
    ...content.account.flatMap((p) => [p.label, p.value]),
    content.due.label,
    content.due.value,
  ].filter((s) => s.length > 0);
}
