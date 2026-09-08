/**
 * The invoice PDF: where each string goes (8.1–8.3, 8.19–8.32).
 *
 * **The layout is the supplied format, kept deliberately close** (8.3, 8.5): the same header
 * fields, the same highlighted boxes, the bonus in its own table above the work with its own
 * subtotal, the same six columns, the same totals stack, the same method-of-payment block. 8.4
 * allows polish and this takes it — a consistent type scale, lighter rules, better spacing — but
 * nothing moves and nothing is dropped.
 *
 * **What the invoice says is `invoiceContent.ts`'s job, not this file's.** A PDF cannot be read
 * back, so a test cannot check the words by looking at the output; splitting them out is what makes
 * them checkable at all. What is left here is geometry, and geometry is what a person looking at
 * the page can check.
 *
 * `pdf-lib` rather than a browser: pure JavaScript, so the server keeps its one-command install
 * instead of needing a hundred megabytes of Chromium to print a page of numbers. The cost is that
 * layout is arithmetic — every column is a named x-offset, and text is measured before it is drawn.
 */

import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { InvoiceDraft } from "@worklog/shared/invoice";
import type { InvoiceConfig } from "./config.ts";
import { type InvoiceContent, invoiceContent } from "./invoiceContent.ts";

// A4, in points.
const PAGE = { w: 595.28, h: 841.89 };
const M = 42;
const CONTENT = PAGE.w - M * 2;

const INK = rgb(0.13, 0.15, 0.18);
const NAVY = rgb(0.11, 0.22, 0.44);
const DIM = rgb(0.36, 0.40, 0.46);
const RULE = rgb(0.85, 0.87, 0.90);
const AMBER = rgb(0.996, 0.941, 0.816);
const BLUE_WASH = rgb(0.867, 0.918, 0.976);
const HEAD_WASH = rgb(0.804, 0.871, 0.957);
const BONUS_WASH = rgb(0.996, 0.973, 0.925);
const SUM_WASH = rgb(0.937, 0.957, 0.984);

/**
 * The six columns of 8.10, laid out right-to-left from the content box.
 *
 * Two rendered pages were needed to get this right, and neither fault would have thrown. First the
 * offsets were absolute guesses and put Rate's right edge past both Amount's and the page margin,
 * so the two printed on top of each other. Then Team/Project's box was wider than the gap before
 * Hours, so "Product Development" ran under it.
 *
 * The money columns are therefore sized from the widest string each can hold — an amount in the
 * tens of thousands, a rate, `129.3` hours — and the text ones take what is left.
 */
const ROW_SIZE = 8.5;

const COL = [
  { x: M + 8, w: 74, align: "left" as const }, // Date: "31 Aug 2026"
  { x: M + 88, w: 170, align: "left" as const }, // Description of work / expense
  { x: M + 264, w: 95, align: "left" as const }, // Team/Project
  { x: M + 400, w: 40, align: "right" as const }, // Hours
  { x: M + 452, w: 48, align: "right" as const }, // Rate
  { x: M + CONTENT - 8, w: 70, align: "right" as const }, // Amount
];

const ROW_H = 19;
const FOOT_ROOM = 60;

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

export async function renderInvoicePdf(
  draft: InvoiceDraft,
  config: InvoiceConfig,
): Promise<Uint8Array> {
  const content = invoiceContent(draft, config);
  const doc = await PDFDocument.create();
  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE.w, PAGE.h]),
    y: PAGE.h - M,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };

  doc.setTitle(`${draft.number}${config.fromName ? ` — ${config.fromName}` : ""}`);
  doc.setProducer("Worklog");
  doc.setCreator("Worklog");

  header(ctx, content);
  billTo(ctx, content);
  period(ctx, content);
  tables(ctx, content);
  totals(ctx, content);
  payment(ctx, content);

  return await doc.save();
}

// ------------------------------------------------------------------ drawing

interface TextOpts {
  size?: number;
  font?: PDFFont;
  color?: ReturnType<typeof rgb>;
  spacing?: number;
}

function text(ctx: Ctx, value: string, x: number, y: number, opts: TextOpts = {}): void {
  if (!value) return;
  ctx.page.drawText(value, {
    x,
    y,
    size: opts.size ?? 9,
    font: opts.font ?? ctx.regular,
    color: opts.color ?? INK,
    ...(opts.spacing === undefined ? {} : { characterSpacing: opts.spacing }),
  });
}

/** Right-aligned, which needs the width measured first — the reason fonts are threaded around. */
function right(ctx: Ctx, value: string, edge: number, y: number, opts: TextOpts = {}): void {
  const font = opts.font ?? ctx.regular;
  text(ctx, value, edge - font.widthOfTextAtSize(value, opts.size ?? 9), y, opts);
}

function box(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  c: ReturnType<typeof rgb>,
): void {
  ctx.page.drawRectangle({ x, y, width: w, height: h, color: c });
}

function rule(ctx: Ctx, y: number, from = M, to = M + CONTENT): void {
  ctx.page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness: 0.6, color: RULE });
}

/** A value in an amber box — how the format emphasises the fields somebody looks for first. */
function highlighted(ctx: Ctx, value: string, x: number, y: number, w: number): void {
  box(ctx, x, y - 4, w, 17, AMBER);
  text(ctx, value, x + 7, y, { font: ctx.bold, size: 9.5 });
}

/** Truncate with an ellipsis rather than overrunning into the next column. */
function fit(ctx: Ctx, value: string, width: number, size = 9, font?: PDFFont): string {
  const f = font ?? ctx.regular;
  if (f.widthOfTextAtSize(value, size) <= width) return value;
  let cut = value;
  while (cut.length > 1 && f.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Wrap on width, because an address is a paragraph and a client name can be long. */
function wrap(font: PDFFont, value: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > width && line) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out;
}

function labelled(ctx: Ctx, label: string, value: string, y: number, labelW: number): void {
  text(ctx, label, M, y, { color: DIM });
  text(ctx, value, M + labelW, y);
}

// ------------------------------------------------------------------ sections

function header(ctx: Ctx, c: InvoiceContent): void {
  ctx.y -= 14;
  text(ctx, "INVOICE", M, ctx.y, { size: 21, font: ctx.bold, color: NAVY, spacing: 4 });
  ctx.y -= 26;

  // 8.24 — the invoice's own identity, top right, highlighted.
  const boxX = M + CONTENT - 150;
  let idY = ctx.y;
  for (const pair of c.identity) {
    right(ctx, pair.label, boxX - 12, idY, { color: DIM });
    highlighted(ctx, pair.value, boxX, idY, 150);
    idY -= 24;
  }

  // 8.23 — who is billing.
  for (const pair of c.from) {
    for (const [i, line] of wrap(ctx.regular, pair.value, 9, 250).entries()) {
      if (i === 0) labelled(ctx, pair.label, line, ctx.y, 148);
      else text(ctx, line, M + 148, ctx.y);
      ctx.y -= 13;
    }
  }
  ctx.y = Math.min(ctx.y, idY) - 8;
}

function billTo(ctx: Ctx, c: InvoiceContent): void {
  // 8.7, 8.25 — set apart, as the format does.
  text(ctx, "BILL TO:", M, ctx.y, { font: ctx.bold, size: 10, color: NAVY, spacing: 1 });
  ctx.y -= 14;
  if (c.billTo.length === 0) return;

  const height = c.billTo.length * 13 + 14;
  box(ctx, M, ctx.y - height + 13, 320, height, BLUE_WASH);
  let y = ctx.y;
  for (const [i, line] of c.billTo.entries()) {
    text(
      ctx,
      fit(ctx, line, 296, i === 0 ? 10 : 9),
      M + 12,
      y,
      i === 0 ? { font: ctx.bold, size: 10 } : {},
    );
    y -= 13;
  }
  ctx.y = ctx.y - height + 4;
}

function period(ctx: Ctx, c: InvoiceContent): void {
  ctx.y -= 20;
  text(ctx, c.period.label, M, ctx.y, { color: DIM });
  highlighted(ctx, c.period.value, M + 118, ctx.y, 210);
  ctx.y -= 34;
}

function tableHead(ctx: Ctx, c: InvoiceContent): void {
  box(ctx, M, ctx.y - 5, CONTENT, ROW_H, HEAD_WASH);
  const opts: TextOpts = { font: ctx.bold, size: ROW_SIZE, color: NAVY };
  cells(ctx, c.columns, opts);
  ctx.y -= ROW_H + 3;
}

function cells(ctx: Ctx, values: readonly string[], opts: TextOpts = {}): void {
  for (const [i, value] of values.entries()) {
    const col = COL[i];
    if (!col || !value) continue;
    const shown = fit(ctx, value, col.w, opts.size ?? ROW_SIZE, opts.font);
    if (col.align === "right") right(ctx, shown, col.x, ctx.y, opts);
    else text(ctx, shown, col.x, ctx.y, opts);
  }
}

/** A new page when the next row would not fit, with the column headings repeated on it. */
function ensureRoom(ctx: Ctx, needed: number, repeat?: InvoiceContent): void {
  if (ctx.y - needed > M + FOOT_ROOM) return;
  ctx.page = ctx.doc.addPage([PAGE.w, PAGE.h]);
  ctx.y = PAGE.h - M;
  if (repeat) tableHead(ctx, repeat);
}

function tables(ctx: Ctx, c: InvoiceContent): void {
  text(ctx, c.heading, M, ctx.y, { font: ctx.bold, size: 10, color: NAVY, spacing: 1 });
  ctx.y -= 22;

  // 8.19 — the bonus, in its own table with its own subtotal row.
  if (c.bonusRow) {
    tableHead(ctx, c);
    box(ctx, M, ctx.y - 5, CONTENT, ROW_H, BONUS_WASH);
    cells(ctx, c.bonusRow, { size: ROW_SIZE });
    ctx.y -= ROW_H + 1;

    box(ctx, M, ctx.y - 5, CONTENT, ROW_H, SUM_WASH);
    cells(ctx, ["", "", "", "", "", c.bonusSubtotal ?? ""], { font: ctx.bold, size: ROW_SIZE });
    ctx.y -= ROW_H + 20;
  }

  tableHead(ctx, c);
  for (const row of c.rows) {
    ensureRoom(ctx, ROW_H, c);
    cells(ctx, row, { size: ROW_SIZE });
    rule(ctx, ctx.y - 6);
    ctx.y -= ROW_H;
  }

  // 8.22 — the work table's own Total, in hours and in money.
  ensureRoom(ctx, ROW_H, c);
  box(ctx, M, ctx.y - 5, CONTENT, ROW_H, SUM_WASH);
  cells(ctx, c.totalRow, { font: ctx.bold, size: ROW_SIZE });
  ctx.y -= ROW_H + 24;
}

function totals(ctx: Ctx, c: InvoiceContent): void {
  ensureRoom(ctx, 92);
  const top = ctx.y;

  // 8.28 — on the left, the currency the rate is in and who approves the work.
  for (const pair of c.aside) {
    labelled(ctx, pair.label, pair.value, ctx.y, 118);
    ctx.y -= 15;
  }

  // 8.29 — on the right, the stack, with TOTAL emphasised.
  const labelRight = M + CONTENT - 168;
  const valueRight = M + CONTENT - 8;
  let y = top;
  for (const [i, pair] of c.totals.entries()) {
    const last = i === c.totals.length - 1;
    const middle = i === 1;
    if (i === 0 || last) box(ctx, labelRight + 8, y - (last ? 5 : 4), 160, last ? 19 : 17, AMBER);
    right(ctx, pair.label, labelRight, y, {
      font: middle ? ctx.italic : ctx.bold,
      size: last ? 11 : 9,
      ...(middle ? { color: DIM } : last ? { color: NAVY } : {}),
    });
    right(ctx, pair.value, valueRight, y, { font: ctx.bold, size: last ? 11 : 9 });
    if (middle) {
      y -= 9;
      rule(ctx, y, labelRight - 50, valueRight);
      y -= 15;
    } else {
      y -= 22;
    }
  }

  ctx.y = Math.min(ctx.y, y) - 20;
}

function payment(ctx: Ctx, c: InvoiceContent): void {
  ensureRoom(ctx, 130);

  text(ctx, c.paymentHeading, M, ctx.y, { font: ctx.bold, size: 10, color: NAVY, spacing: 1 });
  ctx.y -= 20;

  labelled(ctx, c.paymentMethod.label, c.paymentMethod.value, ctx.y, 118);
  // 8.32 — the note sits beside the block rather than under it, as the format has it.
  if (c.note) {
    right(ctx, `(${c.note})`, M + CONTENT, ctx.y, { font: ctx.italic, color: DIM, size: 8.5 });
  }
  ctx.y -= 18;

  for (const pair of c.account) {
    text(ctx, pair.label, M + 118, ctx.y, { font: ctx.bold });
    text(ctx, pair.value, M + 250, ctx.y);
    ctx.y -= 14;
  }

  ctx.y -= 14;
  text(ctx, c.due.label, M, ctx.y, { color: DIM });
  highlighted(ctx, c.due.value, M + 118, ctx.y, 150);
}
