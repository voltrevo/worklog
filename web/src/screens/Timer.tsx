/**
 * The home screen (section 3).
 *
 * **Today's total is the biggest thing on it** (3.1, 19.3), and the running session is deliberately
 * smaller (3.6). That inversion is the point of section 3: the question a contractor asks fifty
 * times a day is "how much have I done today", and the session clock is a detail of how.
 *
 * The total counts up live (3.4) by adding the running session to what the server has recorded,
 * from the start instant the server gave — never from a clock the frontend started.
 */

import { useState } from "react";
import { useStore } from "../state.tsx";
import { clock, duration, hours, pace } from "../format.ts";
import { today } from "@worklog/shared/dates";
import type { WorkEntry } from "@worklog/shared/types";

export function Timer() {
  const { snapshot, call, refresh, phase, lastError, clearError } = useStore();
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const canWrite = phase.k === "ready" && phase.role !== "read";

  if (!snapshot) return <p className="muted">Loading…</p>;

  const active = snapshot.timer.active;
  const runningMs = active ? Math.max(0, Date.now() - active.startedAt) : 0;
  const recordedMs = snapshot.today.reduce(
    (t: number, e: WorkEntry) => t + e.durationMs,
    0,
  );
  const todayMs = recordedMs + runningMs;

  // 3.2, 3.3 — measured against the day's own scheduled hours rather than a monthly average.
  const targetHours = snapshot.pacing.days.find((d) => d.date === today())?.remaining ?? 0;
  const scheduledToday = targetHours + (snapshot.pacing.actualToday ?? 0);
  const targetMs = Math.max(0, scheduledToday) * 3_600_000;
  const remainingMs = targetMs - todayMs;
  const progress = targetMs > 0 ? Math.min(1, todayMs / targetMs) : 0;
  const paced = pace(snapshot.pacing.paceHours);

  const startStop = async () => {
    setBusy(true);
    try {
      if (active) await call({ t: "timer-stop" });
      else {
        await call({
          t: "timer-start",
          billingTag: tag || snapshot.recentTags[0] || "Work",
          // 2.19 — this device's calendar date, decided here and fixed by the server.
          date: today(),
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {lastError && (
        <div className="notice bad row between">
          <span>{lastError}</span>
          <button className="link" type="button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      {snapshot.holidayWarning && (
        // 6.36, 6.37 — a wrong or missing holiday otherwise just shifts the pace with nothing to see.
        <div className="notice warn">{snapshot.holidayWarning}</div>
      )}

      <div className="card">
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3>Today</h3>
            <div className="huge">{duration(todayMs)}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              {targetMs > 0 ? `of ${duration(targetMs)} scheduled` : "not a scheduled workday"}
            </div>
          </div>
          <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
            <span className={`pill ${remainingMs > 0 ? "" : "good"}`}>
              {targetMs === 0
                ? "anything today is extra"
                : remainingMs > 0
                ? `${duration(remainingMs)} left today`
                : `${duration(-remainingMs)} over`}
            </span>
            {/* 3.8 — the monthly pace, beside today's, answering a different question. */}
            <span
              className={`pill ${
                paced.tone === "good" ? "good" : paced.tone === "bad" ? "warn" : ""
              }`}
            >
              {paced.text} this month
            </span>
          </div>
        </div>

        <div className="bar" style={{ marginTop: 16 }}>
          <span
            className={remainingMs < 0 ? "over" : ""}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      <div className="card">
        <div className="row between wrap" style={{ gap: 16 }}>
          <div>
            <h3>Current session</h3>
            {/* 3.5, 3.6 — present, and visually secondary to the figure above. */}
            <div className="big tabular">{active ? clock(runningMs) : "—"}</div>
            <div className="muted">
              {active
                ? (
                  <>
                    Working on <strong>{active.billingTag}</strong>
                  </>
                )
                : "Not working"}
            </div>
          </div>
          <button
            className={`btn big ${active ? "danger" : "primary"}`}
            type="button"
            disabled={!canWrite || busy}
            onClick={() => void startStop()}
          >
            {active ? "■ Stop" : "▶ Start"}
          </button>
        </div>

        {!active && (
          <div className="row" style={{ marginTop: 16 }}>
            <label className="field" style={{ flex: 1 }}>
              Billing tag
              <input
                list="recent-tags"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder={snapshot.recentTags[0] ?? "Product Development"}
                disabled={!canWrite}
              />
            </label>
            {/* 4.6 — autocomplete from what has been used, with no tag-management screen (4.7). */}
            <datalist id="recent-tags">
              {snapshot.recentTags.map((t: string) => <option key={t} value={t} />)}
            </datalist>
          </div>
        )}

        {snapshot.timer.implausible && (
          // 2.16, 2.17 — said out loud, and nothing is corrected on anyone's behalf.
          <div className="notice warn" style={{ marginTop: 12 }}>
            This timer has been running for{" "}
            {hours(runningMs / 3_600_000)}. If you forgot to stop it, stop it and edit the entry in
            History — nothing here will guess a correction for you.
          </div>
        )}
      </div>

      <div className="card">
        <h3>Today's entries</h3>
        {snapshot.today.length === 0
          ? (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Nothing recorded yet today.
            </p>
          )
          : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Billing tag</th>
                    <th style={{ textAlign: "right" }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.today.map((e: WorkEntry) => (
                    <tr key={e.id}>
                      <td>
                        {/* 19.6 — a duration-only entry says so rather than showing invented times. */}
                        {e.timing
                          ? <span className="tabular">{timeRange(e)}</span>
                          : <span className="pill">duration only</span>}
                      </td>
                      <td>{e.billingTag}</td>
                      <td className="tabular" style={{ textAlign: "right" }}>
                        {duration(e.durationMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}

function timeRange(e: WorkEntry): string {
  if (!e.timing) return "";
  const f = (n: number) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(n));
  return `${f(e.timing.startedAt)} – ${f(e.timing.endedAt)}`;
}
