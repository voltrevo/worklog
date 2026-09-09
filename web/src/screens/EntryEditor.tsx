/**
 * One editor for a work entry, whether it is new or not (25.30).
 *
 * **There used to be two.** `AddEntry` was a card pinned above the list, with a mode selector, a
 * duration box and a pair of time boxes; `EditRow` was a table row with its own copies of all of
 * them and its own validation. Two implementations of one idea, so they drifted: the add form
 * refused an end before the start with a sentence explaining why, and the edit row refused it with
 * a different sentence; the add form let you choose a duration or an interval, and the edit row
 * decided for you based on what the entry already was.
 *
 * They are the same editor now, reached the same way — from a control in the list — which is also
 * what gets the permanent form off the top of a screen that is meant to be a list of what happened.
 *
 * **25.28 is the substantive change.** A timed entry's duration box used to be editable, and what
 * you typed into it was discarded: the save path computed the duration from the interval and never
 * looked. Silently. It is read-only now and recomputes as the times change (25.29), which is the
 * honest version of the same claim — the duration *is* the interval. Converting to duration-only
 * is a deliberate button, because it throws the times away.
 */

import { useState } from "react";
import { useStore } from "../state.tsx";
import { duration, instantAt, parseDuration, timeValue } from "../format.ts";
import { today } from "@worklog/shared/dates";
import type { WorkEntry } from "@worklog/shared/types";

type Shape = "duration" | "times";

export function EntryEditor(
  { entry, tags, onClose, onSaved }: {
    /** Absent when adding. */
    entry?: WorkEntry;
    tags: string[];
    onClose: () => void;
    onSaved: () => Promise<void> | void;
  },
) {
  const { call } = useStore();
  const [date, setDate] = useState(entry?.date ?? today());
  const [tag, setTag] = useState(entry?.billingTag ?? tags[0] ?? "");
  const [shape, setShape] = useState<Shape>(
    entry ? (entry.timing ? "times" : "duration") : "duration",
  );
  const [from, setFrom] = useState(entry?.timing ? timeValue(entry.timing.startedAt) : "09:00");
  const [to, setTo] = useState(entry?.timing ? timeValue(entry.timing.endedAt) : "17:00");
  const [text, setText] = useState(entry && !entry.timing ? duration(entry.durationMs) : "");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  /**
   * 25.29 — what the interval currently comes to, recomputed on every keystroke.
   *
   * `undefined` while the pair does not make an interval, which is what stops the field flashing
   * "0.0h" halfway through typing a time. The message beside it says which half is wrong.
   */
  const started = instantAt(date, from);
  const ended = instantAt(date, to);
  const spanMs = started !== undefined && ended !== undefined && ended > started
    ? ended - started
    : undefined;

  const save = async () => {
    const billingTag = tag.trim();
    // 24.1 — refused rather than filled in.
    if (!billingTag) return setProblem("A billing tag is needed.");

    let durationMs: number;
    let timing: { startedAt: number; endedAt: number } | null = null;

    if (shape === "times") {
      if (started === undefined || ended === undefined) {
        return setProblem("Both times are needed, as HH:MM.");
      }
      if (ended <= started) {
        // Deliberately not wrapped to the next day: 2.21 files a session under the day it began,
        // and inventing a midnight crossing from two times on one date would file work somewhere
        // nobody asked for.
        return setProblem("The end time is not after the start time.");
      }
      timing = { startedAt: started, endedAt: ended };
      durationMs = ended - started;
    } else {
      const ms = parseDuration(text);
      if (ms === null || ms <= 0) return setProblem("Try 2h 30m, 2:30, 2.5 or 150m.");
      durationMs = ms;
    }

    setProblem(undefined);
    setBusy(true);
    try {
      if (entry) {
        // `timing: null` rather than omitted, so converting to duration-only actually clears the
        // interval. Omitting it means "leave it as it was", which is the opposite of the button.
        await call({ t: "entry-update", id: entry.id, date, durationMs, billingTag, timing });
      } else {
        await call({
          t: "entry-add",
          date,
          durationMs,
          billingTag,
          ...(timing ? { timing } : {}),
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = entry ? "Edit this entry" : "Add past time";

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card stack" style={{ gap: 14 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>

        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
        >
          <label className="field">
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>

          {
            /*
            The shape is a choice only for a new entry. On an existing one it is a fact about what
            was recorded, and changing it in either direction destroys or invents information — so
            the one direction that is wanted (25.28) is a button that says what it does.
          */
          }
          {!entry && (
            <label className="field">
              Record as
              <select value={shape} onChange={(e) => setShape(e.target.value as Shape)}>
                <option value="duration">a duration</option>
                <option value="times">start and end</option>
              </select>
            </label>
          )}

          {shape === "times" && (
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

          <label className="field">
            How long
            {
              /*
              25.28, 25.2 — present and disabled on a timed entry rather than absent. It is a real
              value that this entry does not get to choose separately; an empty space would read as
              "no duration", which is a different and untrue claim.
            */
            }
            <input
              value={shape === "times" ? (spanMs === undefined ? "—" : duration(spanMs)) : text}
              disabled={shape === "times"}
              onChange={(e) => setText(e.target.value)}
              placeholder="2h 30m"
              title={shape === "times"
                ? "The duration of a timed entry is its interval."
                : undefined}
            />
          </label>

          <label className="field" style={{ minWidth: 160 }}>
            Billing tag
            <input
              list="entry-editor-tags"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Product Development"
            />
          </label>
          <datalist id="entry-editor-tags">
            {tags.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>

        {shape === "times" && entry && (
          <button
            className="link danger"
            type="button"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              // Seeded with what the interval came to, so the conversion starts from the truth
              // rather than from an empty box.
              setText(duration(spanMs ?? entry.durationMs));
              setShape("duration");
            }}
          >
            Convert to a duration only — this discards the start and end times
          </button>
        )}

        {problem && <div className="notice bad">{problem}</div>}

        <div className="row">
          <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
            {entry ? "Save" : "Add"}
          </button>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
