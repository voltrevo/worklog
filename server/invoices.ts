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
  dueDateFor,
  type InvoiceDraft,
  type InvoiceLine,
  type InvoiceRecord,
  type InvoiceSnapshot,
  previousInvoice,
  recomputeDraft,
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
/**
 * A new draft, always (25.10, 25.11).
 *
 * **This used to find the draft for the period and rebuild it.** Two consequences, both wrong.
 * Asking for an invoice for a month that already had a draft silently overwrote that draft — so
 * any editing done on it vanished, and the UI hid the button rather than explain. And the draft
 * was a *view* of the work entries, recomputed on every save and again at issuance, so a draft
 * could never say anything the entries did not: no correction, no extra row, no expense.
 *
 * 25.11 detaches it. The lines are copied out of the work once, here, and from this moment the
 * draft is a document that happens to have been seeded from the work rather than a rendering of
 * it. `updateDraft` edits it; nothing reads back through to the entries. 11.23's `entryIds` is
 * still recorded, because 11.25 needs to know which work this draft claimed — but it is a
 * receipt now, not a dependency.
 *
 * 25.10: any number of these may exist for one period. The refusal is 11.19's, and it applies at
 * issuance, which is where the accounting meaning attaches.
 */
export function createDraft(db: Db, input: DraftInput, now: Instant = Date.now()): StoredInvoice {
  return transact(db, () => {
    const cfg = getConfig(db, "invoice");
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
      number: input.number ?? unusedNumber(all, input.period),
      preparedOn: input.preparedOn ?? today(),
    });

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO invoice (id, period, number, status, draft_json, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, input.period, draft.number, JSON.stringify(draft), now, now);
    return getInvoice(db, id)!;
  });
}

/**
 * `INV-2026-09`, or `INV-2026-09-2` when that is taken.
 *
 * Two drafts for one month is now legal (25.10) and two drafts *called the same thing* is a list
 * you cannot act on — the row you meant and the row you did not are indistinguishable. The unique
 * index only covers issued and paid, so this is a courtesy rather than a constraint, which is why
 * it is a loop and not a refusal.
 */
function unusedNumber(all: readonly StoredInvoice[], period: string): string {
  const taken = new Set(all.map((i) => i.number));
  const base = defaultInvoiceNumber(period);
  if (!taken.has(base)) return base;
  for (let n = 2;; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Edit a draft's rows (25.11).
 *
 * The caller sends rows; the totals are derived here by `recomputeDraft` and never accepted from
 * the wire. A client that computed its own totals would be a second implementation of the
 * arithmetic, and the two would disagree the first time one of them changed.
 */
export function updateDraft(
  db: Db,
  id: string,
  edit: { lines?: InvoiceLine[]; bonusLine?: InvoiceLine | null; number?: string },
  now: Instant = Date.now(),
): StoredInvoice {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
    if (current.status !== "draft") {
      throw new Refused(
        "not-a-draft",
        `invoice ${current.number} is ${current.status}, and an issued invoice does not change`,
      );
    }

    const number = edit.number?.trim() || current.draft.number;
    const draft = recomputeDraft({ ...current.draft, number }, edit);
    db.prepare("UPDATE invoice SET number = ?, draft_json = ?, updated_at = ? WHERE id = ?")
      .run(number, JSON.stringify(draft), now, id);
    return getInvoice(db, id)!;
  });
}

/**
 * 11.5, 11.6 — freeze it.
 *
 * **It used to rebuild the draft from the work first**, on the reasoning that what gets frozen
 * should be what the work says *now* rather than whatever was last previewed. 25.11 makes that
 * reasoning false: a detached draft is edited, and rebuilding it silently discarded every edit at
 * the last possible moment — the one action after which nothing can be undone. What you saw on the
 * screen is what gets frozen.
 *
 * The due date is still recomputed, and only here: 10.7 says a draft's due date moves with the day
 * it is prepared, 10.8 says an issued one never moves again, and this is where the two meet.
 */
export function issue(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) throw new Refused("no-such-invoice", `no invoice ${id}`);
    if (current.status !== "draft") {
      throw new Refused("not-a-draft", `invoice ${current.number} is already ${current.status}`);
    }

    const issuedOn = today();
    const refreshed = recomputeDraft({
      ...current.draft,
      invoiceDate: issuedOn,
      dueDate: dueDateFor(issuedOn),
    }, {});

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
