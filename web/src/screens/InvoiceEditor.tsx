/**
 * Editing a detached draft's rows (25.11).
 *
 * **A draft used to be a view of the work entries.** It was rebuilt on every save and again at
 * issuance, so it could not say anything the entries did not: no correction to a description, no
 * line for an expense, no dropping an hour that turned out to be unbillable. The only way to change
 * an invoice was to change history, which is the wrong thing to change.
 *
 * 25.11 copies the lines out once and hands them over. This is where they are edited.
 *
 * **Nothing here computes money.** The Amount column for an hourly row is `hours × rate` derived on
 * the server by `recomputeDraft`, and this shows what came back. A client that did its own
 * arithmetic would be a second implementation of 25.7, and the two would disagree the first time
 * one of them changed. What this sends is rows.
 *
 * The draft is edited as a whole and saved as a whole. Per-line messages would need conflict
 * handling for a case that does not arise — one person, one invoice, one screen at a time — and
 * would make "cancel" mean nothing, because half the edits would already be on the server.
 */

import { useState } from "react";
import type { InvoiceLine } from "@worklog/shared/invoice";
import type { StoredInvoiceWire } from "@worklog/shared/protocol";
import { money, parseNumber } from "../format.ts";

/** A row being typed into. Text, not numbers: 25.44's rule applies to every one of these fields. */
interface Draft {
  date: string;
  description: string;
  teamProject: string;
  hours: string;
  rate: string;
  amount: string;
}

function toDraft(l: InvoiceLine): Draft {
  return {
    date: l.date ?? "",
    description: l.description,
    teamProject: l.teamProject,
    hours: l.hours === null ? "" : l.hours.toFixed(1),
    rate: l.rateMinor === null ? "" : (l.rateMinor / 100).toFixed(2),
    amount: (l.amountMinor / 100).toFixed(2),
  };
}

/**
 * A typed row back to a line, or the reason it is not one.
 *
 * Hours and rate are either both given or both blank. Half of a pair is not a flat fee and not an
 * hourly row — it is a row somebody is halfway through, and billing it at `0.0 × rate` or at a rate
 * with no hours would be the silent-acceptance fault of 25.3 with money attached.
 */
function fromDraft(d: Draft): { line: InvoiceLine } | { problem: string } {
  const description = d.description.trim();
  if (!description) return { problem: "a line needs a description" };

  const hasHours = d.hours.trim() !== "";
  const hasRate = d.rate.trim() !== "";
  if (hasHours !== hasRate) {
    return {
      problem: `"${description}" has ${
        hasHours ? "hours but no rate" : "a rate but no hours"
      } — give it both, or neither and an amount`,
    };
  }

  const base = {
    date: d.date.trim() || null,
    description,
    teamProject: d.teamProject.trim(),
  };

  if (!hasHours) {
    const amount = parseNumber(d.amount);
    if (amount === undefined) return { problem: `"${description}" needs an amount` };
    return {
      line: { ...base, hours: null, rateMinor: null, amountMinor: Math.round(amount * 100) },
    };
  }

  const hours = parseNumber(d.hours);
  const rate = parseNumber(d.rate);
  if (hours === undefined) return { problem: `the hours on "${description}" are not a number` };
  if (rate === undefined) return { problem: `the rate on "${description}" is not a number` };
  // `amountMinor` is a placeholder: the server derives it. Sending the old one would be a number
  // that disagrees with the row it is attached to for as long as it is in flight.
  return { line: { ...base, hours, rateMinor: Math.round(rate * 100), amountMinor: 0 } };
}

export function InvoiceEditor(
  { invoice, busy, onSave, onCancel }: {
    invoice: StoredInvoiceWire;
    busy: boolean;
    onSave: (lines: InvoiceLine[], number: string) => Promise<void>;
    onCancel: () => void;
  },
) {
  const [rows, setRows] = useState<Draft[]>(invoice.draft.lines.map(toDraft));
  const [number, setNumber] = useState(invoice.draft.number);
  const [problem, setProblem] = useState<string>();

  const currency = invoice.draft.currency;
  const set = (i: number, patch: Partial<Draft>) =>
    setRows(rows.map((r, at) => (at === i ? { ...r, ...patch } : r)));

  const add = () =>
    setRows([...rows, {
      date: "",
      description: "",
      // Defaulted from the draft, because a new row on this invoice is almost always the same
      // project as the rest of it, and retyping it is the only alternative.
      teamProject: invoice.draft.teamProject,
      hours: "",
      rate: (invoice.draft.rateMinor / 100).toFixed(2),
      amount: "0.00",
    }]);

  const save = async () => {
    if (!number.trim()) return setProblem("an invoice needs a number");
    const lines: InvoiceLine[] = [];
    for (const row of rows) {
      const result = fromDraft(row);
      if ("problem" in result) return setProblem(result.problem);
      lines.push(result.line);
    }
    setProblem(undefined);
    await onSave(lines, number.trim());
  };

  // Shown as it will be, from the values on screen — but only where they are all readable. A
  // running total that quietly skips the row you are in the middle of typing is worse than none.
  const preview = rows.map(fromDraft);
  const total = preview.every((r) => "line" in r)
    ? preview.reduce(
      (t, r) =>
        t + ("line" in r && r.line.hours !== null && r.line.rateMinor !== null
          ? Math.round(r.line.hours * r.line.rateMinor)
          : "line" in r
          ? r.line.amountMinor
          : 0),
      0,
    )
    : undefined;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`Edit ${invoice.number}`}>
      <div className="card stack editor" style={{ gap: 14 }}>
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>Edit this draft</h2>
          <label className="field" style={{ minWidth: 190 }}>
            Invoice number
            <input
              value={number}
              onChange={(e) =>
                setNumber(e.target.value)}
            />
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          These lines were copied from the work in {invoice.period}{" "}
          when the draft was made. Changing them here changes this invoice and nothing else — the
          entries in History stay as they are.
        </p>

        <div className="linetable" role="table">
          <div className="linehead" role="row">
            <span>Date</span>
            <span>Description</span>
            <span>Team / Project</span>
            <span className="num">Hours</span>
            <span className="num">Rate</span>
            <span className="num">Amount</span>
            <span />
          </div>
          {rows.length === 0 && (
            <p className="muted" style={{ margin: "8px 0" }}>
              No lines. An invoice with none is legal and comes to nothing; add one below.
            </p>
          )}
          {rows.map((row, i) => {
            const flat = row.hours.trim() === "" && row.rate.trim() === "";
            return (
              <div className="linerow" role="row" key={i}>
                <input
                  type="date"
                  value={row.date}
                  aria-label={`Date on line ${i + 1}`}
                  onChange={(e) => set(i, { date: e.target.value })}
                />
                <input
                  value={row.description}
                  aria-label={`Description on line ${i + 1}`}
                  onChange={(e) =>
                    set(i, { description: e.target.value })}
                />
                <input
                  value={row.teamProject}
                  aria-label={`Team or project on line ${i + 1}`}
                  onChange={(e) =>
                    set(i, { teamProject: e.target.value })}
                />
                <input
                  className="num"
                  inputMode="decimal"
                  value={row.hours}
                  aria-label={`Hours on line ${i + 1}`}
                  onChange={(e) =>
                    set(i, { hours: e.target.value })}
                />
                <input
                  className="num"
                  inputMode="decimal"
                  value={row.rate}
                  aria-label={`Rate on line ${i + 1}`}
                  onChange={(e) => set(i, { rate: e.target.value })}
                />
                {
                  /*
                  25.2 — the amount is present and disabled on an hourly row rather than absent,
                  because it is a real value that this row simply does not get to choose. Leaving
                  the cell empty would read as "no amount", which is a different claim.
                */
                }
                <input
                  className="num"
                  inputMode="decimal"
                  value={row.amount}
                  disabled={!flat}
                  title={flat ? undefined : "Hours times rate. Clear both to set an amount here."}
                  aria-label={`Amount on line ${i + 1}`}
                  onChange={(e) => set(i, { amount: e.target.value })}
                />
                <button
                  className="link danger"
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => setRows(rows.filter((_, at) => at !== i))}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>

        <div className="row between wrap">
          <button className="btn" type="button" onClick={add}>Add a line</button>
          <span className="faint">
            {total === undefined
              ? "Work rows total — once every line reads"
              : `Work rows total ${money(total, currency)}`}
          </span>
        </div>

        {problem && <div className="notice bad">{problem}</div>}

        <div className="row">
          <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
            Save the draft
          </button>
          <button className="btn" type="button" onClick={onCancel}>Discard these changes</button>
        </div>
      </div>
    </div>
  );
}
