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
import { duration, longDate, monthName, parseDuration, timeOfDay } from "../format.ts";
import { monthOf, shiftMonth, today } from "@worklog/shared/dates";
import type { WorkEntry } from "@worklog/shared/types";

export function History() {
  const { snapshot, month, setMonth, call, refresh, phase } = useStore();
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
        <div className="row">
          <button
            className="btn"
            type="button"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <strong style={{ minWidth: 150, textAlign: "center" }}>
            {monthName(month)}
          </strong>
          <button
            className="btn"
            type="button"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
          {month !== monthOf(today()) && (
            <button
              className="btn"
              type="button"
              onClick={() => setMonth(monthOf(today()))}
            >
              This month
            </button>
          )}
        </div>
      </div>

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
                        <div className="how-long tabular">{duration(e.durationMs)}</div>
                        {canWrite && (
                          <div className="acts">
                            <button className="link" type="button" onClick={() => setEditing(e.id)}>
                              Edit
                            </button>
                            <button
                              className="link"
                              type="button"
                              onClick={async () => {
                                await call({ t: "entry-delete", id: e.id });
                                await refresh();
                              }}
                            >
                              Delete
                            </button>
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
                                    : <span className="pill">duration only</span>}
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
                                      <button
                                        className="link"
                                        type="button"
                                        onClick={async () => {
                                          await call({
                                            t: "entry-delete",
                                            id: e.id,
                                          });
                                          await refresh();
                                        }}
                                      >
                                        Delete
                                      </button>
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

function AddEntry({ onAdded }: { onAdded: () => void }) {
  const { call, snapshot } = useStore();
  const [date, setDate] = useState(today());
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ms = parseDuration(text);
    if (ms === null || ms <= 0) {
      setProblem("Try 2h 30m, 2:30, 2.5 or 150m.");
      return;
    }
    setProblem(null);
    await call({
      t: "entry-add",
      date,
      durationMs: ms,
      billingTag: tag || snapshot?.recentTags[0] || "Work",
      // 2.9 — no `timing`, so no invented start and end.
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
          How long
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="2h 30m"
            style={{ width: 110 }}
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Billing tag
          <input
            list="recent-tags-history"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder={snapshot?.recentTags[0] ?? "Product Development"}
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
  const [dropTiming, setDropTiming] = useState(false);

  const save = async () => {
    const ms = parseDuration(text);
    await call({
      t: "entry-update",
      id: entry.id,
      date,
      ...(ms !== null ? { durationMs: ms } : {}),
      billingTag: tag,
      // 2.12 — `null` converts a timed entry to duration-only; omitting it leaves the times alone.
      ...(dropTiming ? { timing: null } : {}),
    });
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
          <label
            className="faint"
            style={{ display: "block", fontSize: 12, marginTop: 4 }}
          >
            <input
              type="checkbox"
              checked={dropTiming}
              onChange={(e) => setDropTiming(e.target.checked)}
            />{" "}
            drop the times
          </label>
        )}
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
