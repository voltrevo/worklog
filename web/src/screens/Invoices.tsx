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
import { bytesFromBase64 } from "../download.ts";
import type {
  InvoicePdfResult,
  PublicInvoiceConfig,
  StoredInvoiceWire,
} from "@worklog/shared/protocol";
import type { InvoiceWarning } from "@worklog/shared/invoice";
import { InvoiceEditor } from "./InvoiceEditor.tsx";
import { Dialog } from "./Dialog.tsx";
import { Sheet } from "./Sheet.tsx";

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

/** The three states, in the order an invoice passes through them (11.2). */
type Status = StoredInvoiceWire["status"];

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
  // 25.12 — what a blank override falls through to, shown in the editor as placeholder text.
  const [config, setConfig] = useState<PublicInvoiceConfig>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const canWrite = phase.k === "ready" && phase.role !== "read";

  const load = async () => {
    setInvoices(await call<StoredInvoiceWire[]>({ t: "invoices" }));
    setConfig((await call<{ invoice: PublicInvoiceConfig }>({ t: "config-get" })).invoice);
  };
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
                  config={config}
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
  { invoice, config, canWrite, busy, act }: {
    invoice: StoredInvoiceWire;
    config: PublicInvoiceConfig | undefined;
    canWrite: boolean;
    busy: boolean;
    act: (body: () => Promise<unknown>) => Promise<void>;
  },
) {
  const { call } = useStore();
  const [viewing, setViewing] = useState<{ url: string; name: string }>();
  const [confirm, setConfirm] = useState<"delete">();
  const [editing, setEditing] = useState(false);
  const shown = invoice.snapshot ?? invoice.draft;

  /**
   * 26.11, 8.33 — fetch it and show it.
   *
   * It used to download. Reading the thing is the common case by a wide margin, and every browser
   * already has a save button on its own PDF viewer, so the app offering one was a second way to
   * do something the first way did better. The blob URL is revoked when the dialog closes.
   */
  const view = async () => {
    const res = await call<InvoicePdfResult>({ t: "invoice-pdf", id: invoice.id });
    const url = URL.createObjectURL(
      // `.slice()` gives a plain `ArrayBuffer`; a `Uint8Array` over a shared buffer is not a
      // `BlobPart` as far as the DOM types are concerned.
      new Blob([bytesFromBase64(res.pdfBase64).slice().buffer], { type: "application/pdf" }),
    );
    setViewing({ url, name: res.fileName });
  };

  /**
   * 26.12 — the three states, in the order an invoice passes through them.
   *
   * The protocol has one message per *edge*, so moving two steps is two calls. Walking the ladder
   * rather than naming every pair keeps that arithmetic in one place: draft → paid is issue then
   * mark-paid, and paid → draft is the reverse in reverse.
   */
  const setState = async (to: Status) => {
    const order: Status[] = ["draft", "issued", "paid"];
    let at = order.indexOf(invoice.status);
    const want = order.indexOf(to);
    while (at < want) {
      await call({ t: at === 0 ? "invoice-issue" : "invoice-mark-paid", id: invoice.id });
      at++;
    }
    while (at > want) {
      await call({ t: at === 2 ? "invoice-unmark-paid" : "invoice-revert-issue", id: invoice.id });
      at--;
    }
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
        {
          /*
          26.12 — one control that sets the state, rather than one button per transition.
          Issue / Mark paid / Revert / Unmark paid were four buttons for three states, appearing
          and disappearing as the state changed, and between them they described the *edges* of a
          graph nobody was thinking about. A state has a name; setting it is choosing the name.
        */
        }
        {canWrite
          ? (
            <label className="field statepick">
              <span className="visually-hidden">Status of {shown.number}</span>
              <select
                value={invoice.status}
                disabled={busy}
                onChange={(e) => void act(() => setState(e.target.value as Status))}
              >
                <option value="draft">Draft</option>
                <option value="issued">Issued</option>
                <option value="paid">Paid</option>
              </select>
            </label>
          )
          : <StatusPill status={invoice.status} />}

        {/* 26.11 — reading it is the common case; saving it is the browser's job. */}
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => void act(view)}
        >
          View
        </button>

        {canWrite && invoice.status === "draft" && (
          /* 25.11 — the draft's own rows, not the work's. */
          <button className="btn" type="button" onClick={() => setEditing(true)}>
            Edit lines
          </button>
        )}
        {canWrite && (
          <>
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
          config={config}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (lines, number, override, taxRate, paymentOverride) => {
            await act(() =>
              call({
                t: "invoice-update",
                id: invoice.id,
                lines,
                number,
                config: override,
                taxRate,
                paymentOverride,
              })
            );
            setEditing(false);
          }}
        />
      )}

      {
        /*
        26.13 — there is no confirmation for issuing. It used to warn that issuing freezes the
        invoice and its PDF. That is the sensible behaviour and the reason the feature exists;
        warning about it reads as an apology for working correctly. A dialog is for the reverse —
        something that would *not* be frozen when you expected it to be.

        Written bare, it was not a comment at all: `/* ... *\/` between JSX tags is text, and the
        whole paragraph rendered under every invoice row.
      */
      }
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

      {
        /*
        26.11 — the document, at a size you can read it at.
        An iframe over the blob URL, so it is the browser's own PDF viewer: it already has page
        controls, search, print and save, all of which this app would otherwise be reimplementing
        worse. The URL is revoked on close, because a blob URL outlives the element that used it.
      */
      }
      {viewing && (
        <Sheet
          label={viewing.name}
          dismissOnBackdrop
          onDismiss={() => {
            URL.revokeObjectURL(viewing.url);
            setViewing(undefined);
          }}
        >
          <div className="card stack viewer" style={{ gap: 10 }}>
            <div className="row between wrap">
              <h2 style={{ margin: 0 }}>{viewing.name}</h2>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(viewing.url);
                  setViewing(undefined);
                }}
              >
                Close
              </button>
            </div>
            <iframe className="viewer-frame" src={viewing.url} title={viewing.name} />
          </div>
        </Sheet>
      )}
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
  if (warning.kind === "invoiced-work-changed") {
    return (
      <div className="notice warn">
        <strong>{warning.invoice.number}</strong> was issued for {hours(warning.wasHours)}{" "}
        of work in {monthName(warning.invoice.period)}, and that work now adds up to{" "}
        {hours(warning.nowHours)}. The invoice is frozen and has not changed; the entries behind it
        have.
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
