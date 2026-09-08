/**
 * Invoices (sections 8–11).
 *
 * **Preview and issuance are visually separate and differently weighted** (19.9, 19.10). Generating
 * a PDF is a plain button; issuing is the only primary action on the screen and says what it will
 * do. 11.4 is the rule behind that: a PDF has no accounting meaning and issuing has all of it, so
 * the two must not sit side by side looking alike.
 *
 * The warnings from 11.24 and 11.25 are at the top rather than beside the invoice they concern,
 * because the second one is *about work that is on no invoice* — there is no row for it to sit next
 * to, which is exactly why it is easy to miss.
 *
 * The tables follow the supplied format (8.3, 8.19–8.29): the bonus is its own table above the
 * work, the work table carries its own Total, and the sub-total / VAT / TOTAL stack sits at the
 * right below both.
 */

import { useEffect, useState } from "react";
import { useStore } from "../state.tsx";
import { hours, longDate, money, monthName, shortDate } from "../format.ts";
import { monthOf, shiftMonth, today } from "@worklog/shared/dates";
import type { InvoiceLine, InvoiceWarning } from "@worklog/shared/invoice";
import type { InvoicePdfResult, StoredInvoiceWire } from "@worklog/shared/protocol";
import { bytesFromBase64, type Saved, saveFile } from "../download.ts";

const COLUMNS = [
  "Date",
  "Description of work / expense",
  "Team / Project",
  "Hours",
  "Rate",
  "Amount",
];

function Head() {
  return (
    <thead>
      <tr>
        {COLUMNS.map((c, i) => (
          <th key={c} style={i >= 3 ? { textAlign: "right" } : undefined}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function Invoices() {
  const { snapshot, call, refresh, phase } = useStore();
  const [invoices, setInvoices] = useState<StoredInvoiceWire[]>();
  const [period, setPeriod] = useState(() => shiftMonth(monthOf(today()), -1));
  const [busy, setBusy] = useState(false);
  const canWrite = phase.k === "ready" && phase.role !== "read";

  const load = async () => setInvoices(await call<StoredInvoiceWire[]>({ t: "invoices" }));

  // 1.12 — follow the store, rather than loading once on mount. An invoice issued or marked paid
  // on another device broadcasts `changed/invoices`, and this list has to show it: two people
  // looking at the same month and disagreeing about whether it has been billed is the exact
  // confusion 11.5's one-invoice-per-month rule exists to prevent.
  useEffect(() => {
    void load();
    // `load` is redefined every render; the snapshot is the signal.
  }, [snapshot]);

  const act = async (body: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await body();
      await load();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const selected = invoices?.find((i) => i.period === period);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Invoices</h1>

      {snapshot?.invoiceWarnings.map((w, i) => <Warning key={i} warning={w} />)}

      <div className="card">
        <div className="row between wrap">
          <div className="row">
            <button
              className="btn"
              type="button"
              onClick={() => setPeriod(shiftMonth(period, -1))}
            >
              ‹
            </button>
            <strong style={{ minWidth: 150, textAlign: "center" }}>
              {monthName(period)}
            </strong>
            <button
              className="btn"
              type="button"
              onClick={() => setPeriod(shiftMonth(period, 1))}
            >
              ›
            </button>
          </div>
          {canWrite && (
            <button
              className="btn"
              type="button"
              disabled={busy ||
                (selected !== undefined && selected.status !== "draft")}
              onClick={() =>
                void act(() =>
                  call({
                    t: "invoice-save",
                    period,
                    clock: { today: today(), nowMinutes: 0 },
                  })
                )}
            >
              {selected ? "Rebuild draft" : "Prepare invoice"}
            </button>
          )}
        </div>

        {!selected && (
          <p className="muted" style={{ marginBottom: 0 }}>
            No invoice for {monthName(period)}{" "}
            yet. Preparing one takes every entry dated in that month — there is nothing to select,
            and nothing gets billed twice because a month can only be issued once.
          </p>
        )}

        {selected && <Draft invoice={selected} busy={busy} canWrite={canWrite} act={act} />}
      </div>

      <div className="card">
        <h3>All invoices</h3>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Number</th>
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Status</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {(invoices ?? []).map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setPeriod(i.period)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{monthName(i.period)}</td>
                  <td className="mono">{i.number}</td>
                  <td className="tabular" style={{ textAlign: "right" }}>
                    {money(
                      (i.snapshot ?? i.draft).totalMinor,
                      i.draft.currency,
                    )}
                  </td>
                  <td>
                    <StatusPill status={i.status} />
                  </td>
                  {/* 11.16 — a due date matters for an issued invoice and means nothing for a draft. */}
                  <td className="tabular">
                    {i.status === "draft" ? "—" : shortDate((i.snapshot ?? i.draft).dueDate)}
                  </td>
                </tr>
              ))}
              {invoices?.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">Nothing yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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

function Draft(
  { invoice, busy, canWrite, act }: {
    invoice: StoredInvoiceWire;
    busy: boolean;
    canWrite: boolean;
    act: (body: () => Promise<unknown>) => Promise<void>;
  },
) {
  const { call } = useStore();
  const shown = invoice.snapshot ?? invoice.draft;
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<Saved>();

  /**
   * 8.33 — generate, then actually hand it over.
   *
   * This used to end at the `call`: the server rendered the document, wrote it into its own data
   * directory, and the button went back to looking exactly as it had. Nothing was broken enough to
   * fail, which is why it survived — the file existed, on a disk the person pressing the button
   * generally cannot reach.
   */
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
    <div className="stack" style={{ gap: 14, marginTop: 14 }}>
      <div className="row between wrap">
        <div>
          <h2>{shown.number}</h2>
          <div className="muted">
            {/* 8.26, 9.23 — the period, the invoice date and the due date are three things. */}
            {periodRange(shown.period)} · invoiced {longDate(shown.invoiceDate)} · due{" "}
            {longDate(shown.dueDate)}
          </div>
        </div>
        <StatusPill status={invoice.status} />
      </div>

      {/* 8.27 */}
      <h3>Description of work performed</h3>

      {/* 8.19 — the bonus is its own table, above the work, with its own subtotal row. */}
      {shown.bonusLine && (
        <div className="scroll-x">
          <table>
            <Head />
            <tbody>
              <tr>
                {/* 8.20 — the row covers the period, so its Date cell says so. */}
                <td className="tabular">{periodRange(shown.period)}</td>
                <td>{shown.bonusLine.description}</td>
                <td>{shown.bonusLine.teamProject}</td>
                <td style={{ textAlign: "right" }}>–</td>
                <td style={{ textAlign: "right" }}>–</td>
                <td className="tabular" style={{ textAlign: "right" }}>
                  {money(shown.bonusLine.amountMinor, shown.currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={5} />
                <td
                  className="tabular"
                  style={{ textAlign: "right", fontWeight: 700 }}
                >
                  {money(shown.bonusLine.amountMinor, shown.currency)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="scroll-x">
        <table>
          <Head />
          <tbody>
            {shown.lines.map((l: InvoiceLine, i: number) => (
              <tr key={i}>
                <td className="tabular">{l.date ? shortDate(l.date) : "—"}</td>
                <td>{l.description}</td>
                <td>{l.teamProject}</td>
                <td className="tabular" style={{ textAlign: "right" }}>
                  {l.hours === null ? "—" : l.hours.toFixed(1)}
                </td>
                <td className="tabular" style={{ textAlign: "right" }}>
                  {l.rateMinor === null ? "—" : money(l.rateMinor, shown.currency)}
                </td>
                <td className="tabular" style={{ textAlign: "right" }}>
                  {money(l.amountMinor, shown.currency)}
                </td>
              </tr>
            ))}
            {/* 8.22 — the work table's own Total, in hours and in money. */}
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                Total
              </td>
              <td
                className="tabular"
                style={{ textAlign: "right", fontWeight: 700 }}
              >
                {shown.workHours.toFixed(1)}
              </td>
              <td />
              <td
                className="tabular"
                style={{ textAlign: "right", fontWeight: 700 }}
              >
                {money(shown.workSubtotalMinor, shown.currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 8.28, 8.29 */}
      <div
        className="row between wrap"
        style={{ alignItems: "flex-start", gap: 24 }}
      >
        <div className="stack" style={{ gap: 4, fontSize: 14 }}>
          <div>
            <span className="muted">Hourly rate in:</span> <strong>{shown.currency}</strong>
          </div>
          {shown.teamProject && (
            <div>
              <span className="muted">Team / Project:</span> <strong>{shown.teamProject}</strong>
            </div>
          )}
        </div>
        <table style={{ width: "auto", minWidth: 280 }}>
          <tbody>
            <tr>
              <td style={{ textAlign: "right" }}>Sub-total</td>
              <td className="tabular" style={{ textAlign: "right" }}>
                {money(shown.subtotalMinor, shown.currency)}
              </td>
            </tr>
            <tr>
              <td style={{ textAlign: "right", fontStyle: "italic" }}>
                {shown.taxRate > 0
                  ? `Tax (${Math.round(shown.taxRate * 100)}%)`
                  : "VAT (if applicable)"}
              </td>
              <td className="tabular" style={{ textAlign: "right" }}>
                {money(shown.taxMinor, shown.currency)}
              </td>
            </tr>
            <tr>
              <td style={{ textAlign: "right", fontWeight: 700 }}>TOTAL</td>
              <td
                className="tabular"
                style={{ textAlign: "right", fontWeight: 700 }}
              >
                {money(shown.totalMinor, shown.currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {canWrite && (
        <div className="row wrap between">
          {/* 19.9 — preview is ordinary, because it means nothing (11.4). */}
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void act(generate)}
          >
            Generate PDF
          </button>
          {saved && (
            // A browser cannot say where its own download went, so it does not pretend to; the
            // desktop shell wrote the file itself and can.
            <span className="muted" style={{ alignSelf: "center" }}>
              {saved.path ? `Saved to ${saved.path}` : `Downloaded ${saved.fileName}`}
            </span>
          )}

          <div className="row wrap">
            {invoice.status === "draft" && !confirming && (
              <button
                className="btn primary"
                type="button"
                onClick={() => setConfirming(true)}
              >
                Mark as issued
              </button>
            )}
            {invoice.status === "issued" && (
              <>
                <button
                  className="btn good"
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => call({ t: "invoice-mark-paid", id: invoice.id }))}
                >
                  Mark as paid
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => call({ t: "invoice-revert-issue", id: invoice.id }))}
                >
                  Revert issuance
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
                Unmark as paid
              </button>
            )}
          </div>
        </div>
      )}

      {confirming && (
        // 11.6 — the sentence says what freezing means, because after this the work and the
        // invoice stop being the same thing.
        <div className="notice warn stack">
          <span>
            Issuing freezes this invoice exactly as it reads now. Editing the work afterwards will
            not change it, and {monthName(invoice.period)}{" "}
            cannot be invoiced again unless you revert.
          </span>
          <div className="row">
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={async () => {
                setConfirming(false);
                await act(() => call({ t: "invoice-issue", id: invoice.id }));
              }}
            >
              Issue it
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => setConfirming(false)}
            >
              Not yet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 8.20, 8.26 — "1 – 31 Aug 2026", the span a period covers. */
function periodRange(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(y, m, 0).getDate();
  const label = new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  })
    .format(new Date(y, m - 1, 1));
  return `1 – ${last} ${label}`;
}

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
