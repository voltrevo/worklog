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
import {
  duration,
  hours,
  instantAt,
  longDate,
  monthName,
  parseDuration,
  timeOfDay,
  timeValue,
} from "../format.ts";
import { today } from "@worklog/shared/dates";
import { MonthNav } from "./MonthNav.tsx";
import { monthReport } from "@worklog/shared/reports";
import type { StoredInvoiceWire } from "@worklog/shared/protocol";
import type { WorkEntry } from "@worklog/shared/types";

export function History() {
  const { snapshot, month, setMonth, refresh, phase } = useStore();
  const presentation = usePresentation();
  const canWrite = phase.k === "ready" && phase.role !== "read";
  const [editing, setEditing] = useState<string | null>(null);

  if (!snapshot) return <p className="muted">Loading…</p>;

  const byDay = new Map<string, WorkEntry[]>();
  for (const e of snapshot.entries) {
    const list = byDay.get(e.date) ?? [];
    list.push(e);
    byDay.set(e.date, list);
  }
  const days = [...byDay.keys()].sort().reverse();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        {presentation === "desktop" && <h1>History</h1>}
        <MonthNav month={month} setMonth={setMonth} />
      </div>

      <MonthTotals />

      {canWrite && <AddEntry onAdded={() => void refresh()} />}

      {days.length === 0
        ? (
          <div className="card muted">
            No work recorded in {monthName(month)}.
          </div>
        )
        : days.map((date) => {
          const entries = byDay.get(date)!;
          const total = entries.reduce((t, e) => t + e.durationMs, 0);
          return (
            <div className="card" key={date}>
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
                            <DeleteEntry id={e.id} onDone={() => void refresh()} />
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
                        {entries.map((e) =>
                          editing === e.id
                            ? (
                              <EditRow
                                key={e.id}
                                entry={e}
                                tags={snapshot.recentTags}
                                onDone={async () => {
                                  setEditing(null);
                                  await refresh();
                                }}
                              />
                            )
                            : (
                              <tr key={e.id}>
                                <td>
                                  {/* 19.6 */}
                                  {e.timing
                                    ? (
                                      <span className="tabular">
                                        {timeOfDay(e.timing.startedAt)} –{" "}
                                        {timeOfDay(e.timing.endedAt)}
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
                                      <DeleteEntry id={e.id} onDone={() => void refresh()} />
                                    </>
                                  )}
                                </td>
                              </tr>
                            )
                        )}
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

function AddEntry({ onAdded }: { onAdded: () => void }) {
  const { call, snapshot } = useStore();
  const [date, setDate] = useState(today());
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  /**
   * 24.11 — a past entry is a duration *or* an interval.
   *
   * 2.9's duration-only form exists so nobody has to invent a start and an end to record that they
   * worked three hours on Tuesday, and it stays. It was the only form available, which is a
   * different thing: when the times are known, typing them should not require inventing a
   * duration instead.
   */
  const [mode, setMode] = useState<"duration" | "times">("duration");
  /**
   * 24.9's fix, applied to the other copy of the same field.
   *
   * The timer screen's tag box used the last-used tag as a *placeholder* while the value stayed
   * empty, so grey text that looks like an empty field silently became the tag. This one did the
   * same thing. It is a real prefilled value here too — and, because 24.1 now refuses an empty
   * tag, leaving it as a placeholder would have turned the confusion into a rejection.
   */
  const [prefilled, setPrefilled] = useState(false);
  if (!prefilled && snapshot?.recentTags.length) {
    setPrefilled(true);
    setTag(snapshot.recentTags[0]!);
  }
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ms = parseDuration(text);
    // 24.1 — the tag is required, and a missing one is refused rather than filled in.
    const billingTag = tag.trim();
    if (!billingTag) {
      setProblem("A billing tag is needed.");
      return;
    }

    let durationMs: number;
    let timing: { startedAt: number; endedAt: number } | undefined;

    if (mode === "times") {
      const startedAt = instantAt(date, from);
      const endedAt = instantAt(date, to);
      if (startedAt === undefined || endedAt === undefined) {
        setProblem("Both times are needed, as HH:MM.");
        return;
      }
      if (endedAt <= startedAt) {
        // Deliberately not wrapped to the next day: 2.21 files a session under the day it began,
        // and silently inventing a midnight crossing from two times on one date would file work
        // somewhere nobody asked for.
        setProblem("The end time is not after the start time.");
        return;
      }
      timing = { startedAt, endedAt };
      durationMs = endedAt - startedAt;
    } else {
      if (ms === null || ms <= 0) {
        setProblem("Try 2h 30m, 2:30, 2.5 or 150m.");
        return;
      }
      durationMs = ms;
    }

    setProblem(null);
    await call({
      t: "entry-add",
      date,
      durationMs,
      billingTag,
      ...(timing ? { timing } : {}),
    });
    setText("");
    onAdded();
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>Add past time</h3>
      <div
        className="row wrap"
        style={{ marginTop: 8, alignItems: "flex-end" }}
      >
        <label className="field">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="field">
          Record as
          <select value={mode} onChange={(e) => setMode(e.target.value as "duration" | "times")}>
            <option value="duration">a duration</option>
            <option value="times">start and end</option>
          </select>
        </label>
        {mode === "duration"
          ? (
            <label className="field">
              How long
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="2h 30m"
                style={{ width: 110 }}
              />
            </label>
          )
          : (
            <>
              <label className="field">
                From
                <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field">
                To
                <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </>
          )}
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Billing tag
          <input
            list="recent-tags-history"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Product Development"
          />
        </label>
        <datalist id="recent-tags-history">
          {snapshot?.recentTags.map((t: string) => (
            <option
              key={t}
              value={t}
            />
          ))}
        </datalist>
        <button className="btn primary" type="submit">Add</button>
      </div>
      {problem && <div className="notice warn" style={{ marginTop: 10 }}>{problem}</div>}
    </form>
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
function DeleteEntry({ id, onDone }: { id: string; onDone: () => Promise<void> | void }) {
  const { call } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button className="link" type="button" onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <>
      <span className="faint">Delete?</span>{" "}
      <button
        className="link danger"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await call({ t: "entry-delete", id });
            await onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        Yes, delete
      </button>{" "}
      <button className="link" type="button" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </>
  );
}

function EditRow(
  { entry, tags, onDone }: {
    entry: WorkEntry;
    tags: string[];
    onDone: () => Promise<void>;
  },
) {
  const { call } = useStore();
  const [text, setText] = useState(duration(entry.durationMs));
  const [tag, setTag] = useState(entry.billingTag);
  const [date, setDate] = useState(entry.date);
  /**
   * 24.12 — the times are editable.
   *
   * The only edit available to a timed entry used to be a "drop the times" checkbox, which is the
   * one change to an interval nobody needs: an interval that is wrong is wrong by a few minutes,
   * not wrong by being an interval. 2.12's conversion is gone with it — deleting the entry and
   * adding a duration-only one does the same thing without a checkbox that means "discard data".
   */
  const [from, setFrom] = useState(entry.timing ? timeValue(entry.timing.startedAt) : "");
  const [to, setTo] = useState(entry.timing ? timeValue(entry.timing.endedAt) : "");
  const [problem, setProblem] = useState<string>();

  const save = async () => {
    const billingTag = tag.trim();
    if (!billingTag) {
      setProblem("A billing tag is needed.");
      return;
    }

    // A timed entry's duration is its interval; there is no third number to disagree with.
    if (entry.timing) {
      const startedAt = instantAt(date, from);
      const endedAt = instantAt(date, to);
      if (startedAt === undefined || endedAt === undefined) {
        setProblem("Both times are needed, as HH:MM.");
        return;
      }
      if (endedAt <= startedAt) {
        setProblem("The end time is not after the start time.");
        return;
      }
      await call({
        t: "entry-update",
        id: entry.id,
        date,
        billingTag,
        durationMs: endedAt - startedAt,
        timing: { startedAt, endedAt },
      });
      await onDone();
      return;
    }

    const ms = parseDuration(text);
    if (ms === null || ms <= 0) {
      setProblem("Try 2h 30m, 2:30, 2.5 or 150m.");
      return;
    }
    await call({ t: "entry-update", id: entry.id, date, durationMs: ms, billingTag });
    await onDone();
  };

  return (
    <tr>
      <td>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        {entry.timing && (
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            <input
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="Start time"
            />
            <span className="faint">–</span>
            <input
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="End time"
            />
          </div>
        )}
        {problem && <div className="faint" style={{ fontSize: 12 }}>{problem}</div>}
      </td>
      <td>
        <input
          list="recent-tags-history"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
        <datalist id="recent-tags-history">
          {tags.map((t) => <option key={t} value={t} />)}
        </datalist>
      </td>
      <td style={{ textAlign: "right" }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ width: 90 }}
        />
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <button
          className="btn primary"
          type="button"
          onClick={() => void save()}
        >
          Save
        </button>{" "}
        <button className="btn" type="button" onClick={() => void onDone()}>
          Cancel
        </button>
      </td>
    </tr>
  );
}
