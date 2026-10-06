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

import type { DateString, Instant, InvoiceStatus } from "@worklog/shared/types";
import type { InvoiceEdit } from "@worklog/shared/protocol";
import {
  appliedOverride,
  appliedPaymentOverride,
  buildDraft,
  canIssue,
  defaultInvoiceNumber,
  dueDateFor,
  type InvoiceDraft,
  type InvoiceRecord,
  type InvoiceSnapshot,
  type PaymentOverride,
  previousInvoice,
  recomputeDraft,
} from "@worklog/shared/invoice";
import { today } from "@worklog/shared/dates";
import { type Db, transact } from "./db.ts";
import { getConfig, type InvoiceConfig } from "./config.ts";
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
  /**
   * Read only to answer "is there one" — `toRecord` turns it into a boolean and never lets the
   * string past. The values have their own reader, which nothing serialises.
   */
  override_secrets_json: string | null;
}

function toRecord(
  row: Row,
): InvoiceRecord & { draft: InvoiceDraft; pdfPath?: string; paymentOverridden: boolean } {
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
    /*
     * 25.12, 25.42 — whether, never what.
     *
     * A boolean is safe on the wire and the values are not, so the conversion happens at the one
     * point that reads this column into something a handler returns.
     */
    paymentOverridden: row.override_secrets_json !== null,
  };
}

export type StoredInvoice = ReturnType<typeof toRecord>;

/**
 * The configuration an invoice was issued under (24.30).
 *
 * **Deliberately not on `StoredInvoice`.** That record is what the handlers return down the wire,
 * and this holds the payment block. A field is safe here only for as long as nobody adds it to
 * something that gets serialised, and "for as long as nobody" is not a boundary. So it is not
 * there at all: one column, one reader, and the only caller is the PDF path.
 *
 * `undefined` for a draft, and for anything issued before this column existed — the caller falls
 * back to the current settings, which is what it did for everything before.
 */
export function paymentOverrideFor(db: Db, id: string): PaymentOverride | undefined {
  const row = db.prepare("SELECT override_secrets_json FROM invoice WHERE id = ?").get(id) as
    | { override_secrets_json: string | null }
    | undefined;
  return row?.override_secrets_json
    ? JSON.parse(row.override_secrets_json) as PaymentOverride
    : undefined;
}

export function frozenConfigFor(db: Db, id: string): InvoiceConfig | undefined {
  const row = db.prepare("SELECT config_json FROM invoice WHERE id = ?").get(id) as
    | { config_json: string | null }
    | undefined;
  return row?.config_json ? JSON.parse(row.config_json) as InvoiceConfig : undefined;
}

/**
 * 11.29 — the settings a draft's document was first generated with, or `undefined` if it has not
 * been generated since it was made or last edited.
 *
 * While this is set, the file at `pdf_path` is that draft's document and is served as it is. It is
 * the marker rather than `pdf_path` itself, because the path stays pointed at the old file across
 * an edit: the next render overwrites it in place, and deleting the invoice still finds it.
 */
export function draftSettingsFor(db: Db, id: string): InvoiceConfig | undefined {
  const row = db.prepare("SELECT draft_settings_json FROM invoice WHERE id = ?").get(id) as
    | { draft_settings_json: string | null }
    | undefined;
  return row?.draft_settings_json
    ? JSON.parse(row.draft_settings_json) as InvoiceConfig
    : undefined;
}

/** 11.29 — record that a draft's document was generated, and with which settings. */
export function keepDraftDocument(
  db: Db,
  id: string,
  path: string,
  settings: InvoiceConfig,
  now: Instant = Date.now(),
): void {
  db.prepare(
    "UPDATE invoice SET pdf_path = ?, draft_settings_json = ?, updated_at = ? WHERE id = ?",
  ).run(path, JSON.stringify(settings), now, id);
}

const SELECT =
  `SELECT id, period, number, status, draft_json, snapshot_json, pdf_path, issued_at, paid_at,
          override_secrets_json
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
  /*
   * A period is a calendar month.
   *
   * `createDraft({ period: "banana" })` used to produce a draft with no lines and the number
   * `INV-banana`, which then sat in the list forever: it covers no month, so no work can ever
   * belong to it, and nothing anywhere reports it as wrong. The frontend only offers real months
   * from a `<select>`, which is exactly why nothing had noticed.
   */
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new Refused("bad-period", `${JSON.stringify(input.period)} is not a calendar month`);
  }
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
  // 27.47 — the wire's own shape. It was written out again here, and a third time in the
  // handler's field-by-field forwarding.
  edit: InvoiceEdit,
  now: Instant = Date.now(),
): StoredInvoice {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) {
      throw new Refused(
        "no-such-invoice",
        "that invoice no longer exists; it was probably deleted on another device",
      );
    }
    if (current.status !== "draft") {
      throw new Refused(
        "not-a-draft",
        `invoice ${current.number} is ${current.status}, and an issued invoice does not change`,
      );
    }

    const number = edit.number?.trim() || current.draft.number;
    // A document reference, not a paragraph. It also becomes the name of a downloaded file.
    if (number.length > 80) {
      throw new Refused("number-too-long", "an invoice number is at most 80 characters");
    }
    if (edit.taxRate !== undefined && !(edit.taxRate >= 0 && edit.taxRate < 1)) {
      // A rate outside this is a percentage somebody typed into a fraction field, and silently
      // billing 250% tax is 25.3 at its most expensive.
      throw new Refused("bad-tax-rate", `a tax rate of ${edit.taxRate} is not a fraction`);
    }
    // Recomputed *after* the tax rate is applied, not before: the tax line is derived from it, so
    // storing the new rate beside the old tax figure would leave the document disagreeing with
    // itself until the next unrelated edit.
    if (edit.paymentOverride) {
      const merged = {
        ...paymentOverrideFor(db, id),
        ...appliedPaymentOverride(edit.paymentOverride),
      };
      db.prepare("UPDATE invoice SET override_secrets_json = ? WHERE id = ?")
        .run(Object.keys(merged).length ? JSON.stringify(merged) : null, id);
    }

    const draft = recomputeDraft({
      ...current.draft,
      number,
      ...(edit.currency !== undefined ? { currency: edit.currency } : {}),
      ...(edit.taxRate !== undefined ? { taxRate: edit.taxRate } : {}),
      ...(edit.config !== undefined ? { config: edit.config } : {}),
    }, edit);
    // 11.29 — editing the draft is the one thing that changes its document, so the one it was
    // generated with is no longer it. The next view regenerates, with the settings as they are then.
    db.prepare(
      `UPDATE invoice SET number = ?, draft_json = ?, draft_settings_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(number, JSON.stringify(draft), now, id);
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
/**
 * @param issuedOn the calendar day of the person issuing it (27.51).
 *
 * Required, and not defaulted to `today()`, because that default *was* the bug: this stamps
 * `invoiceDate` and the due date derived from it onto a document, and 10.8 freezes both at this
 * moment. Read from the server's clock they were the date wherever the server happens to run — a
 * container in UTC, most often — so anybody east of it issuing before mid-morning got yesterday.
 * `invoice-create` three cases away already took the device's `clock.today`; issuance did not.
 */
export function issue(
  db: Db,
  id: string,
  now: Instant,
  issuedOn: DateString,
): StoredInvoice {
  return transact(db, () => {
    const current = getInvoice(db, id);
    if (!current) {
      throw new Refused(
        "no-such-invoice",
        "that invoice no longer exists; it was probably deleted on another device",
      );
    }
    if (current.status !== "draft") {
      throw new Refused("not-a-draft", `invoice ${current.number} is already ${current.status}`);
    }

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
    // 24.30 — the settings this invoice went out under, so a lost PDF re-renders as the document
    // that was sent rather than as one wearing today's letterhead. Resolved here, override and
    // all (25.12), because that is what the renderer was handed.
    const frozenConfig: InvoiceConfig = {
      // 11.29 — the settings the draft was generated with, so what is issued is what was looked
      // at; the current ones only for a draft nobody generated before issuing it.
      ...(draftSettingsFor(db, id) ?? getConfig(db, "invoice")),
      ...appliedOverride(refreshed.config),
      ...appliedPaymentOverride(paymentOverrideFor(db, id)),
    };
    db.prepare(
      `UPDATE invoice SET status = 'issued', number = ?, draft_json = ?, snapshot_json = ?,
                          config_json = ?, issued_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      refreshed.number,
      JSON.stringify(refreshed),
      JSON.stringify(snapshot),
      JSON.stringify(frozenConfig),
      now,
      now,
      id,
    );
    return getInvoice(db, id)!;
  });
}

/** 11.9, 11.11 */
export function markPaid(db: Db, id: string, now: Instant = Date.now()): StoredInvoice {
  const current = getInvoice(db, id);
  if (!current) {
    throw new Refused(
      "no-such-invoice",
      "that invoice no longer exists; it was probably deleted on another device",
    );
  }
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
  if (!current) {
    throw new Refused(
      "no-such-invoice",
      "that invoice no longer exists; it was probably deleted on another device",
    );
  }
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
  if (!current) {
    throw new Refused(
      "no-such-invoice",
      "that invoice no longer exists; it was probably deleted on another device",
    );
  }
  if (current.status !== "issued") {
    throw new Refused(
      "not-issued",
      current.status === "paid"
        ? `unmark ${current.number} as paid before reverting its issuance`
        : `invoice ${current.number} has not been issued`,
    );
  }
  /*
   * The snapshot survives, deliberately (27.41).
   *
   * It is the record of what was actually sent, and reverting says the issuance was a mistake —
   * not that it never happened. Clearing it would make a later re-issue silently produce a
   * different document from the one somebody has already received, with nothing left to compare.
   *
   * **It is not what the invoice currently says**, and that distinction has already caught one
   * reader out: the invoices list rendered `snapshot ?? draft` and so showed a reverted invoice's
   * issued figures while the draft changed underneath it. Anything reading a snapshot has to ask
   * the status first. `pdf_path` survives for the same reason and is not served while the status
   * is draft; a re-issue overwrites that file.
   */
  // 11.29 — the issued file stays this draft's document until the draft is edited, so a revert
  // changes the status and not the document. The settings that file was made with become the
  // draft's kept settings; `COALESCE` because a draft generated before it was issued already has
  // them, and they are the ones the issued document was built from.
  db.prepare(
    `UPDATE invoice SET status = 'draft', issued_at = NULL,
     draft_settings_json = COALESCE(draft_settings_json, config_json), updated_at = ? WHERE id = ?`,
  ).run(now, id);
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
    if (!current) {
      throw new Refused(
        "no-such-invoice",
        "that invoice no longer exists; it was probably deleted on another device",
      );
    }
    db.prepare("DELETE FROM invoice WHERE id = ?").run(id);
    return current.pdfPath ? { pdfPath: current.pdfPath } : {};
  });
}
