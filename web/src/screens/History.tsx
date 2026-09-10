/**
 * Work history, by day, fully editable (2.6, 2.7, 2.14).
 *
 * **Adding past time is one row and three fields** (2.15, 19.7): a date, a duration, a tag. It does
 * not ask for start and end times, because 2.9 says a duration-only entry is a first-class thing
 * and inventing "09:00–11:00" for two hours you half remember is a lie the invoice would then
 * repeat.
 */

import { useState } from "react";
import { useStore } from "../state.tsx";
import { usePresentation } from "../App.tsx";
import { duration, hours, longDate, monthName, timeOfDay } from "../format.ts";
import { addDays } from "@worklog/shared/dates";
import { MonthNav } from "./MonthNav.tsx";
import { EntryEditor } from "./EntryEditor.tsx";
import { Dialog } from "./Dialog.tsx";
import { monthReport } from "@worklog/shared/reports";
import type { StoredInvoiceWire } from "@worklog/shared/protocol";
import type { WorkEntry } from "@worklog/shared/types";

export function History() {
  const { snapshot, month, setMonth, refresh, phase } = useStore();
  const presentation = usePresentation();
  const canWrite = phase.k === "ready" && phase.role !== "read";
  /**
   * 25.30 — one editor, and what it is editing.
   *
   * `"new"` for adding, an id for editing. It used to be an id or null, with adding handled by a
   * separate form permanently mounted above the list, which is how the two drifted apart.
   */
  const [editing, setEditing] = useState<string | "new" | null>(null);

  if (!snapshot) return <p className="muted">Loading…</p>;

  const byDay = new Map<string, WorkEntry[]>();
  for (const e of snapshot.entries) {
    const list = byDay.get(e.date) ?? [];
    list.push(e);
    byDay.set(e.date, list);
  }
  const days = [...byDay.keys()].sort().reverse();

  return (
    /*
     * 27.18 — two spacings, and they mean something.
     *
     * One gap for everything put the month's totals, the control that adds to it, and every day
     * of the month at the same distance from each other — so the page read as nine unrelated
     * cards rather than a summary and a list. The smaller gap holds a group together; the larger
     * one separates groups. The month card and "Add past time" are one group, and each run of
     * consecutive days with work in it is another, so a day nobody worked shows up as space.
     */
    <div className="stack historystack">
      <div className="row between wrap">
        {presentation === "desktop" && <h1>History</h1>}
        <MonthNav month={month} setMonth={setMonth} />
      </div>

      <MonthTotals />

      {/* 25.30 — a control in the list, not a form standing permanently above it. */}
      {canWrite && (
        <div className="row">
          <button className="btn" type="button" onClick={() => setEditing("new")}>
            Add past time
          </button>
        </div>
      )}

      {
        /*
         * 27.38 — and whether the thing being edited is still there.
         *
         * `find` returns `undefined` when the entry has been deleted since this editor opened, and
         * `EntryEditor` reads no entry as *adding* one. So an entry corrected on a phone while a
         * laptop had the editor open turned that editor into an Add form, silently, still holding
         * the deleted entry's values — and the button that said Save now said Add and made a
         * second entry. The two states have to be told apart here, because this is the only place
         * that knows an id was asked for.
         */
      }
      {editing !== null && (() => {
        const found = editing === "new"
          ? undefined
          : snapshot.entries.find((e: WorkEntry) => e.id === editing);
        return (
          <EntryEditor
            entry={found}
            vanished={editing !== "new" && found === undefined}
            tags={snapshot.recentTags}
            onClose={() => setEditing(null)}
            onSaved={() => refresh()}
          />
        );
      })()}

      {days.length === 0
        ? (
          <div className="card muted">
            No work recorded in {monthName(month)}.
          </div>
        )
        : days.map((date, i) => {
          const entries = byDay.get(date)!;
          const total = entries.reduce((t, e) => t + e.durationMs, 0);
          // Newest first, so the previous card is the *next* day. A break is any day between the
          // two with nothing recorded, and the first card always starts a group.
          const previous = days[i - 1];
          const consecutive = previous !== undefined && addDays(date, 1) === previous;
          return (
            <div className={`card${consecutive ? "" : " groupstart"}`} key={date}>
              <div className="row between" style={{ marginBottom: 10 }}>
                <h2>{longDate(date)}</h2>
                <span className="pill accent tabular">{duration(total)}</span>
              </div>
              {presentation === "mobile"
                ? (
                  <div className="entries">
                    {entries.map((e) => (
                      <div className="entry" key={e.id}>
                        <div className="what">
                          <strong>{e.billingTag}</strong>
                          <span className="faint">
                            {/* 19.6 — still distinguished, just not in a column. */}
                            {e.timing
                              ? `${timeOfDay(e.timing.startedAt)} – ${timeOfDay(e.timing.endedAt)}`
                              : "duration only"}
                          </span>
                        </div>
                        <div className="how-long tabular">
                          {duration(e.durationMs)}
                        </div>
                        {canWrite && (
                          <div className="acts">
                            <button
                              className="link"
                              type="button"
                              onClick={() => setEditing(e.id)}
                            >
                              Edit
                            </button>
                            <DeleteEntry entry={e} onDone={() => void refresh()} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div className="scroll-x">
                    <table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Billing tag</th>
                          <th style={{ textAlign: "right" }}>Duration</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((e) => (
                          <tr key={e.id}>
                            <td>
                              {/* 19.6 */}
                              {e.timing
                                ? (
                                  <span className="tabular">
                                    {timeOfDay(e.timing.startedAt)} – {timeOfDay(e.timing.endedAt)}
                                  </span>
                                )
                                : (
                                  <span className="pill">
                                    duration only
                                  </span>
                                )}
                            </td>
                            {/* 19.5 — the tag is visible while reviewing, not hidden behind an edit. */}
                            <td>{e.billingTag}</td>
                            <td
                              className="tabular"
                              style={{ textAlign: "right" }}
                            >
                              {duration(e.durationMs)}
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {canWrite && (
                                <>
                                  <button
                                    className="link"
                                    type="button"
                                    onClick={() => setEditing(e.id)}
                                  >
                                    Edit
                                  </button>
                                  {" · "}
                                  <DeleteEntry entry={e} onDone={() => void refresh()} />
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          );
        })}
    </div>
  );
}

/**
 * 7.1, 7.2, 7.5, 7.6, 7.8 — the month in one card.
 *
 * On the history screen rather than a screen of its own, because "what did this month come to" is
 * the question somebody has *while* looking at the days, and a report they have to navigate to is
 * a report they check once a quarter.
 */
function MonthTotals() {
  const { snapshot, month } = useStore();
  // 24.16 — invoice state was shown here as a chip and is not shown any more: invoicing lives on
  // the invoices screen, and a month's hours are its hours whether or not they have been billed.
  const invoices: StoredInvoiceWire[] = [];

  if (!snapshot) return null;
  // 24.15 — an empty month shows zeros rather than nothing. Hiding the card made an empty month
  // look like a different screen, and the first thing you do on landing there is work out whether
  // the app is broken or the month is.
  const report = monthReport(month, snapshot.entries, invoices);

  return (
    <div className="card">
      <div className="row between wrap">
        <div>
          <h3>{monthName(month)}</h3>
          <div className="big tabular">{hours(report.totalHours)}</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 6, marginTop: 14 }}>
        {report.byTag.map((t) => (
          <div className="tagrow" key={t.tag}>
            <span className="name">{t.tag}</span>
            <span className="track">
              <span style={{ width: `${Math.round(t.share * 100)}%` }} />
            </span>
            <span className="tabular figure">{hours(t.hours)}</span>
            <span className="faint days">
              {t.days} day{t.days === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Delete, with a confirmation (24.13, 24.3).
 *
 * It used to be a bare link that deleted on the first click. An entry is somebody's record of an
 * afternoon and there is no undo, so the click that destroys it should not be the same click that
 * a mis-aim produces. Two clicks, and the second one is the red one.
 *
 * One component because the row is drawn twice — stacked on a phone, a table cell on a desktop —
 * and a confirmation that exists in one of them is a confirmation you cannot rely on.
 */
function DeleteEntry(
  { entry, onDone }: { entry: WorkEntry; onDone: () => Promise<void> | void },
) {
  const { call } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button className="link danger" type="button" onClick={() => setConfirming(true)}>
        Delete
      </button>
      {
        /*
        25.4 — a dialog, not a second link where the first one was.
        This used to swap "Delete" for "Delete? Yes, delete / Keep" in place. The confirming click
        landed a few pixels from where the first one did, which for a fast double-click is no
        confirmation at all; and on the desktop table it changed the width of the cell, so the row
        moved under the pointer between the two clicks. The same dialog as everything else that
        cannot be undone by clicking again.
      */
      }
      {confirming && (
        <Dialog
          title="Delete this entry?"
          body={`${duration(entry.durationMs)} on ${
            longDate(entry.date)
          }, tagged "${entry.billingTag}". There is no undo.`}
          confirmLabel="Yes, delete"
          danger
          busy={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              await call({ t: "entry-delete", id: entry.id });
              setConfirming(false);
              await onDone();
            } finally {
              setBusy(false);
            }
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
