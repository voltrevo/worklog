/**
 * The invoice lifecycle, over the database (section 11).
 *
 * The arithmetic and the rules live in `shared/invoice.ts`, where they can be tested without a
 * database. What is here is the part that needs one: reading the work, holding the draft, and the
 * four state changes.
 *
 * **The refusals are enforced twice, deliberately.** `canIssue` checks in application code so the
 * caller gets a reason it can show; the partial unique indexes check in SQLite so a race cannot get
 * past. Neither is redundant — one produces a sentence, the other produces a guarantee.
 */

import type { Instant, InvoiceStatus } from "@worklog/shared/types";
import {
  buildDraft,
  canIssue,
  defaultInvoiceNumber,
  type InvoiceDraft,
  type InvoiceRecord,
  type InvoiceSnapshot,
  previousInvoice,
} from "@worklog/shared/invoice";
import { today } from "@worklog/shared/dates";
import { type Db, transact } from "./db.ts";
import { getConfig } from "./config.ts";
import { entriesInMonth, Refused } from "./work.ts";

interface Row {
  id: string;
  period: string;
  number: string;
  status: string;
  draft_json: string;
  snapshot_json: string | null;
  pdf_path: string | null;
  issued_at: number | null;
  paid_at: number | null;
}

function toRecord(row: Row): InvoiceRecord & { draft: InvoiceDraft; pdfPath?: string } {
  return {
    id: row.id,
    period: row.period,
    number: row.number,
    status: row.status as InvoiceStatus,
    draft: JSON.parse(row.draft_json) as InvoiceDraft,
    ...(row.snapshot_json ? { snapshot: JSON.parse(row.snapshot_json) as InvoiceSnapshot } : {}),
    ...(row.pdf_path ? { pdfPath: row.pdf_path } : {}),
    ...(row.issued_at === null ? {} : { issuedAt: Number(row.issued_at) }),
    ...(row.paid_at === null ? {} : { paidAt: Number(row.paid_at) }),
  };
}

export type StoredInvoice = ReturnType<typeof toRecord>;

const SELECT =
  `SELECT id, period, number, status, draft_json, snapshot_json, pdf_path, issued_at, paid_at
   FROM invoice`;

export function listInvoices(db: Db): StoredInvoice[] {
  return db.prepare(`${SELECT} ORDER BY period DESC`).all().map((r) => toRecord(r as never));
}

export function getInvoice(db: Db, id: string): StoredInvoice | undefined {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row ? toRecord(row as never) : undefined;
}

/**
 * The invoice for a period, preferring a committed one over a draft.
 *
 * `status = 'draft'` is 1 for drafts and 0 for everything else, so ascending puts the issued or
 * paid invoice first. That is the one a caller means by "the invoice for September" — 11.20 allows
 * at most one of it, while 11.22 allows any number of drafts alongside.
 */
export function invoiceForPeriod(db: Db, period: string): StoredInvoice | undefined {
  const row = db.prepare(`${SELECT} WHERE period = ? ORDER BY status = 'draft', id LIMIT 1`)
    .get(period);
  return row ? toRecord(row as never) : undefined;
}

export interface DraftInput {
  period: string;
  /** 9.7, 9.9 — overrides for this invoice; anything omitted comes from 9.8/9.10's defaults. */
  teamProject?: string;
  bonusMinor?: number;
  number?: string;
  /** The viewing device's today, for 10.1's due date. */
  preparedOn?: string;
}

/**
 * Build or rebuild the draft for a period from the work as it stands (8.16, 10.7).
 *
 * Defaults come from the previous invoice by period (9.8, 9.10, 9.13) and fall back to the
 * configured seed. Rebuilding an existing draft keeps its id and number, so a PDF regenerated after
 * an edit is the same invoice rather than a new one.
 */
export function saveDraft(db: Db, input: DraftInput, now: Instant = Date.now()): StoredInvoice {
  return transact(db, () => {
    const cfg = getConfig(db, "invoice");
    const existing = invoiceForPeriod(db, input.period);
    if (existing && existing.status !== "draft") {
      throw new Refused("already-issued", `the invoice for ${input.period} has been issued`);
    }

    const all = listInvoices(db);
    const prev = previousInvoice(all, input.period);
    const teamProject = input.teamProject ?? prev?.draft.teamProject ?? cfg.teamProject;
    const bonusMinor = input.bonusMinor ?? prev?.draft.bonusMinor ?? cfg.bonusMinor;

    const draft = buildDraft({
      period: input.period,
      entries: entriesInMonth(db, input.period),
      teamProject,
      rateMinor: cfg.rateMinor,
      bonusMinor,
      currency: cfg.currency,
      taxRate: cfg.taxRate,
      number: input.number ?? existing?.number ?? defaultInvoiceNumber(input.period),
      preparedOn: input.preparedOn ?? today(),
    });

    const id = existing?.id ?? crypto.randomUUID();
    db.prepare(
      `INSERT INTO invoice (id, period, number, status, draft_json, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET number = excluded.number,
                                      draft_json = excluded.draft_json,
                                      updated_at = excluded.updated_at`,
    ).run(id, input.period, draft.number, JSON.stringify(draft), now, now);
    return getInvoice(db, id)!;
  });
}

/**
 * 11.5, 11.6 — freeze it.
 *
 * The draft is rebuilt from the current work first, so what is frozen is what the work says *now*
 * rather than whatever was last previewed. After this the snapshot is the invoice, and 11.8's
 * promise holds because nothing reads back through it to the entries.
 */
export function issue(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
    if (current.status !== "draft") {
      throw new Refused("not-a-draft", `invoice ${current.number} is already ${current.status}`);
    }

    // Rebuilt here rather than through `saveDraft`, which finds an invoice by *period* and would
    // pick a different draft if two exist for the same month -- which 11.22 permits. This must
    // freeze the invoice the caller named.
    const cfg = getConfig(db, "invoice");
    const refreshed = buildDraft({
      period: current.period,
      entries: entriesInMonth(db, current.period),
      teamProject: current.draft.teamProject,
      rateMinor: cfg.rateMinor,
      bonusMinor: current.draft.bonusMinor,
      currency: cfg.currency,
      taxRate: cfg.taxRate,
      number: current.number,
      // 10.7 and 10.8 meet here: the due date is recomputed one last time, from the day of
      // issuance, and then never again.
      preparedOn: today(),
    });

    const verdict = canIssue(refreshed, listInvoices(db).filter((i) => i.id !== id));
    if (!verdict.ok) {
      throw new Refused(
        verdict.reason,
        verdict.reason === "period-taken"
          ? `${current.period} is already covered by ${verdict.by.number}`
          : `invoice number ${refreshed.number} is already used by ${verdict.by.period}`,
      );
    }

    const snapshot: InvoiceSnapshot = { ...refreshed, issuedAt: now };
    db.prepare(
      `UPDATE invoice SET status = 'issued', number = ?, draft_json = ?, snapshot_json = ?,
                          issued_at = ?, updated_at = ? WHERE id = ?`,
    ).run(refreshed.number, JSON.stringify(refreshed), JSON.stringify(snapshot), now, now, id);
    return getInvoice(db, id)!;
  });
}

/** 11.9, 11.11 */
export function markPaid(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  const current = getInvoice(db, id);
  if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
  if (current.status !== "issued") {
    throw new Refused("not-issued", `only an issued invoice can be marked paid`);
  }
  db.prepare("UPDATE invoice SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
  return getInvoice(db, id)!;
}

/** 11.12 — a correction, and explicit (11.14). The snapshot stays; only the payment is undone. */
export function unmarkPaid(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  const current = getInvoice(db, id);
  if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
  if (current.status !== "paid") {
    throw new Refused("not-paid", `invoice ${current.number} is not paid`);
  }
  db.prepare("UPDATE invoice SET status = 'issued', paid_at = NULL, updated_at = ? WHERE id = ?")
    .run(now, id);
  return getInvoice(db, id)!;
}

/**
 * 11.13 — revert an issuance, which frees the period (11.21).
 *
 * The snapshot is **kept**, not deleted. It is the record of what was sent to a client, and a
 * correction to our own bookkeeping is not a reason to lose it; 11.18 wants it retained. What
 * changes is the status, which is what the unique indexes key on.
 */
export function revertIssue(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  const current = getInvoice(db, id);
  if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
  if (current.status !== "issued") {
    throw new Refused(
      "not-issued",
      current.status === "paid"
        ? `unmark ${current.number} as paid before reverting its issuance`
        : `invoice ${current.number} has not been issued`,
    );
  }
  db.prepare("UPDATE invoice SET status = 'draft', issued_at = NULL, updated_at = ? WHERE id = ?")
    .run(now, id);
  return getInvoice(db, id)!;
}

/** 17.11 — the PDF is a file; this records where. */
export function attachPdf(db: Db, id: string, path: string, now: Instant = Date.now()): void {
  db.prepare("UPDATE invoice SET pdf_path = ?, updated_at = ? WHERE id = ?").run(path, now, id);
}

/**
 * 24.28 — remove an invoice at any stage, and say which file went with it.
 *
 * Deleting an *issued* invoice is allowed on purpose. 11.5's rule is that a month may carry only
 * one issued invoice, and without a delete the only ways out of a mistake were reverting it to a
 * draft forever or living with it. The row is the record; if it should not exist, it should not
 * exist.
 *
 * Returns the PDF path rather than removing the file, because the store owns rows and the caller
 * owns the data directory.
 */
export function deleteInvoice(db: Db, id: string): { pdfPath?: string } {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
    db.prepare("DELETE FROM invoice WHERE id = ?").run(id);
    return current.pdfPath ? { pdfPath: current.pdfPath } : {};
  });
}
