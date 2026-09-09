/**
 * Invoices: one list, and actions on the rows of it (24.25–24.29).
 *
 * **There is no "current" invoice**, and no preview (24.26). This screen used to pick a month, show whichever invoice
 * belonged to it, and render a full preview of that document — the line table, the bonus table,
 * the sub-total and VAT stack. Three things were wrong with that. The preview duplicated the PDF,
 * which is the artefact that matters and is one click away. The month selector invented a piece of
 * state, "the invoice you are looking at", that the domain does not have. And every lifecycle
 * action hung off that selection, so acting on an invoice meant navigating to it first.
 *
 * What a list needs is the period, the number, the hours, the amount and the status; what an
 * invoice needs is issue, mark paid, revert, delete and its PDF. Both of those fit on a row.
 *
 * **Ordering is by what needs attention** (24.25): drafts and issued-but-unpaid first, newest
 * period first within each, then the paid ones. Sorting purely by date buries the one invoice that
 * is overdue underneath a year of settled ones.
 */

import { useEffect, useState } from "react";
import { useStore } from "../state.tsx";
import { hours, longDate, money, monthName, shortDate } from "../format.ts";
import { monthOf, shiftMonth, today } from "@worklog/shared/dates";
import { bytesFromBase64, type Saved, saveFile } from "../download.ts";
import type { InvoicePdfResult, StoredInvoiceWire } from "@worklog/shared/protocol";
import type { InvoiceWarning } from "@worklog/shared/invoice";
import { InvoiceEditor } from "./InvoiceEditor.tsx";

/**
 * The months on offer: the last two years, newest first.
 *
 * A fixed list rather than `<input type="month">`, which the desktop shell's WebKitGTK renders as
 * a bare text box — a control that works in one of the two places this app runs is worse than one
 * that looks the same in both. Two years back is past the point where an uninvoiced month is a
 * different problem from this one.
 */
function monthChoices(): string[] {
  const now = monthOf(today());
  return Array.from({ length: 24 }, (_, i) => shiftMonth(now, -i));
}

/** Unpaid first, and within that the most recent period. */
function ordered(invoices: StoredInvoiceWire[]): StoredInvoiceWire[] {
  const rank = (i: StoredInvoiceWire) => (i.status === "paid" ? 1 : 0);
  return [...invoices].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.period < b.period ? 1 : a.period > b.period ? -1 : 0)
  );
}

export function Invoices() {
  const { snapshot, call, refresh, phase } = useStore();
  const [invoices, setInvoices] = useState<StoredInvoiceWire[]>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const canWrite = phase.k === "ready" && phase.role !== "read";

  const load = async () => setInvoices(await call<StoredInvoiceWire[]>({ t: "invoices" }));
  // 1.12 — follow the store, so an invoice issued on another device appears here.
  useEffect(() => {
    void load().catch(() => {});
  }, [snapshot]);

  /**
   * Every action goes through here so a refusal lands somewhere visible.
   *
   * 24.31's refusal — "Settings needs the client's address, the BSB … before an invoice can be
   * made" — is the point of that change, and a refusal swallowed by a `catch` is the old behaviour
   * with extra steps.
   */
  const act = async (body: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await body();
      await load();
      await refresh();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 25.9 — prefilled to last month, because that is the month you invoice.
   *
   * The month is only a *default* now. It used to be the whole vocabulary: two buttons, "Prepare
   * August" and "Prepare September", each vanishing once that month had a draft — so the control
   * was missing exactly when you had already used it once, and there was no way at all to invoice
   * July.
   */
  const [period, setPeriod] = useState(shiftMonth(monthOf(today()), -1));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        <h1>Invoices</h1>
        {canWrite && (
          <div className="row wrap" style={{ alignItems: "flex-end" }}>
            <label className="field">
              Month
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              >
                {monthChoices().map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </select>
            </label>
            {/* 25.8 — always here, whatever is already in the list. 25.10 is what allows it. */}
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  call({
                    t: "invoice-create",
                    period,
                    clock: { today: today(), nowMinutes: 0 },
                  })
                )}
            >
              New invoice
            </button>
          </div>
        )}
      </div>

      {problem && <div className="notice bad">{problem}</div>}
      {snapshot?.invoiceWarnings.map((w, i) => <Warning key={i} warning={w} />)}

      <div className="card">
        {invoices === undefined
          ? <p className="muted" style={{ margin: 0 }}>Loading…</p>
          : invoices.length === 0
          ? (
            <p className="muted" style={{ margin: 0 }}>
              No invoices yet. Preparing one takes every entry dated in that month.
            </p>
          )
          : (
            <div className="entries">
              {ordered(invoices).map((i) => (
                <InvoiceRow
                  key={i.id}
                  invoice={i}
                  canWrite={canWrite}
                  busy={busy}
                  act={act}
                />
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: StoredInvoiceWire["status"] }) {
  // 11.15, 11.17 — a draft has to look unlike the other two, because it is the one with no meaning.
  if (status === "draft") return <span className="pill">Draft</span>;
  if (status === "issued") return <span className="pill warn">Issued</span>;
  return <span className="pill good">Paid</span>;
}

function InvoiceRow(
  { invoice, canWrite, busy, act }: {
    invoice: StoredInvoiceWire;
    canWrite: boolean;
    busy: boolean;
    act: (body: () => Promise<unknown>) => Promise<void>;
  },
) {
  const { call } = useStore();
  const [saved, setSaved] = useState<Saved>();
  const [confirm, setConfirm] = useState<"issue" | "delete">();
  const [editing, setEditing] = useState(false);
  const shown = invoice.snapshot ?? invoice.draft;

  /** 8.33 — generate, then actually hand it over. */
  const generate = async () => {
    const res = await call<InvoicePdfResult>({
      t: "invoice-pdf",
      id: invoice.id,
    });
    setSaved(
      await saveFile(
        res.fileName,
        bytesFromBase64(res.pdfBase64),
        "application/pdf",
      ),
    );
  };

  return (
    <div className="stacked-row">
      <div className="what">
        <strong>
          {monthName(invoice.period)} · {shown.number}
        </strong>
        <span className="faint">
          {hours(shown.workHours)} · {money(shown.totalMinor, shown.currency)}
          {/* 11.16 — a due date matters for an issued invoice and means nothing for a draft. */}
          {invoice.status !== "draft" && ` · due ${longDate(shown.dueDate)}`}
        </span>
      </div>

      <div className="acts wrap">
        <StatusPill status={invoice.status} />

        {/* 25.13 — what the button does is download; that it is a PDF is what it downloads. */}
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => void act(generate)}
        >
          Download
        </button>
        {saved && (
          <span className="faint">
            {saved.path ? `Saved to ${saved.path}` : `Downloaded ${saved.fileName}`}
          </span>
        )}

        {canWrite && (
          <>
            {invoice.status === "draft" && (
              <>
                {/* 25.11 — the draft's own rows, not the work's. */}
                <button
                  className="btn"
                  type="button"
                  onClick={() => setEditing(true)}
                >
                  Edit lines
                </button>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => setConfirm("issue")}
                >
                  Issue
                </button>
              </>
            )}
            {invoice.status === "issued" && (
              <>
                <button
                  className="btn good"
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => call({ t: "invoice-mark-paid", id: invoice.id }))}
                >
                  Mark paid
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => call({ t: "invoice-revert-issue", id: invoice.id }))}
                >
                  Revert
                </button>
              </>
            )}
            {invoice.status === "paid" && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => void act(() => call({ t: "invoice-unmark-paid", id: invoice.id }))}
              >
                Unmark paid
              </button>
            )}
            <button
              className="link danger"
              type="button"
              onClick={() => setConfirm("delete")}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {editing && (
        <InvoiceEditor
          invoice={invoice}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (lines, number) => {
            await act(() => call({ t: "invoice-update", id: invoice.id, lines, number }));
            setEditing(false);
          }}
        />
      )}

      {/* 24.29 — a dialog, rather than a paragraph wedged into the row. */}
      {confirm === "issue" && (
        <Dialog
          title={`Issue ${shown.number}?`}
          body={`Issuing freezes this invoice exactly as it reads now, and freezes its PDF. Editing the work afterwards will not change it, and ${
            monthName(invoice.period)
          } cannot be invoiced again unless you revert or delete this one.`}
          confirmLabel="Issue it"
          busy={busy}
          onConfirm={async () => {
            setConfirm(undefined);
            await act(() => call({ t: "invoice-issue", id: invoice.id }));
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
      {confirm === "delete" && (
        <Dialog
          title={`Delete ${shown.number}?`}
          body={invoice.status === "draft"
            ? "A draft has no accounting meaning, so nothing goes but the draft itself."
            : `This invoice has been ${invoice.status}. Deleting it removes the record and its frozen PDF, and frees ${
              monthName(invoice.period)
            } to be invoiced again.`}
          confirmLabel="Delete it"
          danger
          busy={busy}
          onConfirm={async () => {
            setConfirm(undefined);
            await act(() => call({ t: "invoice-delete", id: invoice.id }));
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
    </div>
  );
}

/**
 * 24.29 — a modal, used by both confirmations.
 *
 * The same `.sheet` as the work-note panel, so this app has one thing that means "answer before
 * carrying on" rather than two that look slightly different.
 */
function Dialog(
  { title, body, confirmLabel, danger, busy, onConfirm, onCancel }: {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    busy: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  },
) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card stack" style={{ gap: 14, maxWidth: 520 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <p className="muted" style={{ margin: 0 }}>{body}</p>
        <div className="row">
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

/** 11.24, 11.25 — about work that is on no invoice, so there is no row for it to sit beside. */
function Warning({ warning }: { warning: InvoiceWarning }) {
  if (warning.kind === "uninvoiced-month") {
    return (
      <div className="notice warn">
        <strong>{monthName(warning.month)}</strong> has {hours(warning.hours)}{" "}
        of work and was never invoiced, but {monthName(warning.laterInvoice.period)} has been.
      </div>
    );
  }
  return (
    <div className="notice warn">
      {hours(warning.entry.durationMs / 3_600_000)} on{" "}
      <strong>{shortDate(warning.entry.date)}</strong> ({warning.entry.billingTag}) is not on{" "}
      <strong>{warning.invoice.number}</strong>, which covers that month and has already been
      issued.
    </div>
  );
}
