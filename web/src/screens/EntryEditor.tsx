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
 * honest version of the same claim — the duration *is* the interval.
 *
 * **27.20 finished the job 25.30 started.** One component, but not yet one form: adding chose the
 * shape from a dropdown, and editing hid the dropdown and offered a one-way button reading
 * "Convert to a duration only — this discards the start and end times". Two controls for one
 * choice, and the button's warning was about a loss that has not happened — nothing is saved until
 * Save, and the times sit in state the whole time the duration box is showing. So it is the same
 * dropdown in both, both ways, and switching back gives the times back.
 */

import { useRef, useState } from "react";
import { Sheet } from "./Sheet.tsx";
import { Dialog } from "./Dialog.tsx";
import { useStore } from "../state.tsx";
import { duration, instantAt, parseDuration, timeValue } from "../format.ts";
import { today } from "@worklog/shared/dates";
import type { WorkEntry } from "@worklog/shared/types";

type Shape = "duration" | "times";

export function EntryEditor(
  { entry, vanished, tags, onClose, onSaved }: {
    /** Absent when adding, and also when the entry being edited has gone — see `vanished`. */
    entry?: WorkEntry;
    /**
     * 27.38 — set when this opened on an entry that has since been deleted elsewhere.
     *
     * Without it, "no entry" means "adding one", and an editor whose subject was deleted on
     * another device turned into an Add form with the deleted values in it. The distinction cannot
     * be made here: only the caller knows whether an id was asked for.
     */
    vanished?: boolean;
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

  /*
   * 26.26 — the same question as the note and the invoice editor.
   *
   * A date, a tag, times, a duration typed by hand: less to lose than an invoice's lines, and
   * still somebody's work. A snapshot compared against what the panel opened with, so an untouched
   * form closes without a word and a half-filled one does not.
   */
  const initial = useRef<string>(undefined);
  const filled = JSON.stringify([date, tag, shape, from, to, text]);
  initial.current ??= filled;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const leave = () => {
    if (filled === initial.current) onClose();
    else setConfirmDiscard(true);
  };

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

  const title = vanished ? "This entry has gone" : entry ? "Edit this entry" : "Add past time";

  return (
    <Sheet label={title} onDismiss={leave}>
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

          {/* 27.20 — the same control on an existing entry as on a new one, both directions. */}
          <label className="field">
            Record as
            <select
              value={shape}
              onChange={(e) => {
                const next = e.target.value as Shape;
                /*
                 * Seed the duration box from the interval, but only when nothing has been typed
                 * into it. A duration you wrote is yours: switching to times and back has to give
                 * that back rather than a number recomputed from the times you left behind.
                 *
                 * Falling back to the entry's own duration, because the boxes carry HH:MM and a
                 * session shorter than a minute has a start and an end that are equal — no
                 * interval, and an empty box would be the one reading of a real two-second entry
                 * that is false.
                 */
                const known = spanMs ?? entry?.durationMs;
                if (next === "duration" && !text.trim() && known !== undefined) {
                  setText(duration(known));
                }
                setShape(next);
              }}
            >
              <option value="duration">a duration</option>
              <option value="times">start and end</option>
            </select>
          </label>

          {
            /* 27.19 — one line, because they are one thing. The pair takes a whole row of the
               grid, so the two boxes sit side by side at every width instead of the auto-fit
               deciding to stack them. */
          }
          {shape === "times" && (
            <div className="timepair">
              <label className="field">
                From
                <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field">
                To
                <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
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

        {
          /*
           * 27.38 — said, and then offered as a choice rather than made into one.
           *
           * Adding it back is exactly what the old behaviour did, and the fault was that it did it
           * without saying so. The typing is still on screen and still worth something, so the way
           * out is a button that says what it will do.
           */
        }
        {vanished && (
          <div className="notice warn">
            This entry was deleted, probably on another device, so there is nothing here to save.
            What is filled in can still be added as a new entry.
          </div>
        )}

        {problem && <div className="notice bad">{problem}</div>}

        <div className="row">
          <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
            {vanished ? "Add it back as a new entry" : entry ? "Save" : "Add"}
          </button>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>

      {confirmDiscard && (
        <Dialog
          title="Throw this away?"
          body="What you have filled in has not been saved. Closing loses it."
          confirmLabel="Throw it away"
          danger
          busy={false}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Sheet>
  );
}
