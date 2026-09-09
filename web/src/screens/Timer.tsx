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
import {
  clock,
  dateValue,
  duration,
  hours,
  instantAt,
  pace,
  timeOfDay,
  timeValue,
} from "../format.ts";
import { today } from "@worklog/shared/dates";
import type { WorkEntry } from "@worklog/shared/types";

export function Timer() {
  const { snapshot, call, refresh, phase, lastError, clearError } = useStore();
  const [tag, setTag] = useState("");
  const [tagProblem, setTagProblem] = useState<string>();
  /**
   * 24.9 — the last tag used is *prefilled*, not defaulted.
   *
   * It used to be the input's placeholder while the value stayed empty, and `startStop` then read
   * `tag || recentTags[0] || "Work"`. Two things were wrong with that. Grey placeholder text looks
   * like an empty field, so starting a timer produced "Working on Feature development" out of what
   * appeared to be nothing; and on a fresh server with no history at all the chain fell through to
   * the invented word "Work", which is 24.1's whole complaint. Now the box holds a real value that
   * can be seen and edited, and an empty one is refused.
   */
  const [prefilled, setPrefilled] = useState(false);
  const running = snapshot?.timer.active?.billingTag;
  if (!prefilled && (running ?? snapshot?.recentTags[0])) {
    setPrefilled(true);
    setTag(running ?? snapshot!.recentTags[0]!);
  }
  const [busy, setBusy] = useState(false);
  /**
   * 25.27. Held as text while it is being typed into, per 25.44.
   *
   * Up here with the other hooks and not beside `moveStart`, which is below `if (!snapshot)
   * return` — a `useState` after an early return is called on some renders and not others, and
   * React's response to that is to throw and take the whole screen with it.
   */
  const [startEdit, setStartEdit] = useState<string | undefined>(undefined);
  const [startProblem, setStartProblem] = useState<string>();
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
  // 25.24 — from the snapshot's own figure for today, not from the viewed month's days.
  const targetMs = snapshot.todayScheduledHours * 3_600_000;
  const remainingMs = targetMs - todayMs;
  const progress = targetMs > 0 ? Math.min(1, todayMs / targetMs) : 0;

  /*
   * 25.26, 26.19 — the pieces the bar is made of, inside a fill that is exactly the right size.
   *
   * Each segment used to be a percentage of the whole track, with `gap: 2px` between them and a
   * `min-width: 3px` on each. Both add width the data did not ask for: six short sessions added
   * ten pixels of gap and up to eighteen of minimum, so starting and stopping the timer repeatedly
   * advanced the bar far faster than the work did. A progress bar that is wrong in the direction
   * of "you have done more than you have" is worse than no bar.
   *
   * So the *fill* is `progress` wide and exact, and the segments divide it by `flex-grow`. Gaps
   * and rounding now consume space inside the fill instead of extending it, which is what makes
   * both true at once: the total is right, and the parts are still visibly parts.
   *
   * `progress` is already capped at 1, so the old `scale` correction for an over-run day is gone
   * with the arithmetic that needed it.
   */
  const segments = [
    ...snapshot.today.map((e: WorkEntry) => ({
      key: e.id,
      ms: e.durationMs,
      running: false,
    })),
    ...(active ? [{ key: "running", ms: runningMs, running: true }] : []),
  ]
    // A zero-width segment is a gap with a rounded end on each side: visible, and meaningless.
    .filter((seg) => seg.ms > 0);
  const paced = pace(snapshot.pacing.paceHours);

  const moveStart = async () => {
    if (!active || startEdit === undefined) return;
    // Against the date the *session* began on, not against today: a session started before
    // midnight is still running now, and reading its new start against today would move it a day
    // forward and land it in the future.
    const startedAt = instantAt(dateValue(active.startedAt), startEdit);
    if (startedAt === undefined) return setStartProblem("A start time is needed, as HH:MM.");
    setStartProblem(undefined);
    setBusy(true);
    try {
      await call({ t: "timer-set-start", startedAt });
      setStartEdit(undefined);
      await refresh();
    } catch (err) {
      setStartProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retag = async () => {
    const wanted = tag.trim();
    if (!wanted) {
      setTagProblem("A billing tag is needed.");
      return;
    }
    setBusy(true);
    try {
      await call({ t: "timer-retag", billingTag: wanted });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const startStop = async () => {
    // Refused here as well as on the server (24.1, 24.9). The server's refusal is the one that
    // counts; this one exists so the message appears beside the field rather than in the
    // connection-error strip at the top of the screen.
    if (!active && !tag.trim()) {
      setTagProblem("A billing tag is needed before the timer can start.");
      return;
    }
    setTagProblem(undefined);
    setBusy(true);
    try {
      if (active) await call({ t: "timer-stop" });
      else {
        await call({
          t: "timer-start",
          billingTag: tag.trim(),
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
    <div className="timerscreen">
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

      <div className="card today">
        <div className="row between today-head">
          <div className="today-figure">
            <h3>Today</h3>
            <div className="huge">{duration(todayMs)}</div>
            <div className="muted today-sub" style={{ marginTop: 4 }}>
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

        {
          /*
          25.26 — one segment per entry, each with its own rounded ends.

          A single fill says "you have done 5.2 of 8 hours" and stops there. The same width split
          into the sessions it was actually made of says the same thing and also that it was six
          sittings rather than one, which is the shape of the day and is not recoverable from a
          bar. The running session is the last segment and grows as you watch.
        */
        }
        <div className="bar segmented">
          <div className="bar-fill" style={{ width: `${progress * 100}%` }}>
            {segments.map((seg) => (
              <span
                key={seg.key}
                className={remainingMs < 0 ? "over" : ""}
                // Proportional *within* the fill, so the separators cost the segments and not
                // the total.
                style={{ flexGrow: seg.ms }}
                title={`${duration(seg.ms)}${seg.running ? " — still running" : ""}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="card session">
        <div className="row between wrap" style={{ gap: 16 }}>
          <div>
            <h3>Current session</h3>
            {/* 3.5, 3.6 — present, and visually secondary to the figure above. */}
            <div className="big tabular">{active ? clock(runningMs) : "—"}</div>
            <div className="muted">
              {active
                ? (
                  <>
                    Working on <strong>{active.billingTag}</strong>, since{" "}
                    <button
                      className="link"
                      type="button"
                      disabled={!canWrite}
                      onClick={() => setStartEdit(timeValue(active.startedAt))}
                    >
                      {timeOfDay(active.startedAt)}
                    </button>
                  </>
                )
                : "Not working"}
            </div>
            {
              /*
              25.27 — the case is forgetting to press Start. You notice at 11:20 that you began at
              09:30, and the only remedies were to stop and hand-add a past entry, or to record
              the wrong thing. Both throw away the fact that you are still working.
            */
            }
            {active && startEdit !== undefined && (
              <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                <input
                  type="time"
                  value={startEdit}
                  aria-label="Started at"
                  onChange={(e) =>
                    setStartEdit(e.target.value)}
                />
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void moveStart()}
                >
                  Move the start
                </button>
                <button className="btn" type="button" onClick={() => setStartEdit(undefined)}>
                  Cancel
                </button>
              </div>
            )}
            {startProblem && (
              <div className="notice bad" style={{ marginTop: 8 }}>{startProblem}</div>
            )}
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

        {
          /*
          24.10 — the same field whether the timer is running or not.
          Realising at three o'clock that the morning has been filed under the wrong tag used to
          mean stopping the timer, editing the entry in History and starting a new one. It is the
          same value either way, so it is the same input either way; while a timer runs it saves
          against the running timer.
        */
        }
        <div className="row wrap" style={{ marginTop: 16, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            Billing tag
            <input
              list="recent-tags"
              value={tag}
              onChange={(e) => {
                setTag(e.target.value);
                setTagProblem(undefined);
              }}
              placeholder="Product Development"
              disabled={!canWrite}
            />
          </label>
          {/* 4.6 — autocomplete from what has been used, with no tag-management screen (4.7). */}
          <datalist id="recent-tags">
            {snapshot.recentTags.map((t: string) => <option key={t} value={t} />)}
          </datalist>
          {active && canWrite && tag.trim() !== active.billingTag && (
            <button
              className="btn"
              type="button"
              disabled={busy || !tag.trim()}
              onClick={() => void retag()}
            >
              Retag this session
            </button>
          )}
        </div>
        {tagProblem && <div className="notice warn" style={{ marginTop: 10 }}>{tagProblem}</div>}

        {snapshot.timer.implausible && (
          // 2.16, 2.17 — said out loud, and nothing is corrected on anyone's behalf.
          <div className="notice warn" style={{ marginTop: 12 }}>
            This timer has been running for{" "}
            {hours(runningMs / 3_600_000)}. If you forgot to stop it, stop it and edit the entry in
            History — nothing here will guess a correction for you.
          </div>
        )}
      </div>
    </div>
  );
}
