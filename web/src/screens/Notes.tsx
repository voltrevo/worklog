/**
 * Work notes, on their own screen (24.4).
 *
 * They started as a card on the timer screen, on the reasoning that a note is written about work
 * that is happening now and the timer is where you already are. In use that made the timer screen
 * four boxes deep and buried the two figures it exists to show, so notes moved here and the timer
 * kept the clock (24.2).
 *
 * A note is not billable time (5.1) and nothing here touches an entry or a total.
 */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../state.tsx";
import { WorkNote } from "./WorkNote.tsx";
import type { WorkNoteWire as NoteWire } from "@worklog/shared/protocol";
import { Listing } from "./Listing.tsx";
import { Dialog } from "./Dialog.tsx";

export function Notes() {
  const { call, snapshot, phase, refresh } = useStore();
  // 25.1 — `undefined` until the first answer. `[]` would say "no notes" before asking.
  const [notes, setNotes] = useState<NoteWire[]>();
  const [open, setOpen] = useState(false);
  const canWrite = phase.k === "ready" && phase.role !== "read";

  const load = () =>
    void call<NoteWire[]>({ t: "notes", limit: 200 }).then(setNotes).catch(() => {});
  useEffect(load, [call, snapshot]);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        <h1>Work notes</h1>
        {canWrite && (
          <button className="btn primary" type="button" onClick={() => setOpen(true)}>
            New work note
          </button>
        )}
      </div>

      <div className="card">
        <Listing items={notes} empty="Nothing noted yet.">
          {(rows) => (
            <div className="entries">
              {rows.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  canWrite={canWrite}
                  onChanged={() => void refresh()}
                />
              ))}
            </div>
          )}
        </Listing>
      </div>

      {open && <WorkNote onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * One note.
 *
 * **A spoken note is described, not apologised for** (24.7). This used to render the body, and for
 * a voice note there is no body, so it printed the italic words "a recording" where the text would
 * have been — which reads as a note whose content failed to load rather than a note that is
 * audio. A voice note now says how long it is and offers to play it, and the row is the same shape
 * either way.
 */
function NoteRow(
  { note, canWrite, onChanged }: {
    note: NoteWire;
    canWrite: boolean;
    onChanged: () => void;
  },
) {
  const { call } = useStore();
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();

  /**
   * 5.28, 25.37 — fetched when somebody asks to hear it, and then it plays.
   *
   * Pressing Play used to *replace* the button with an `<audio controls>` that had to be pressed
   * again. Two presses to hear one thing, the second one landing where the first had been, and
   * nothing in between saying anything was happening — on a note of any size the button simply
   * looked broken until the player appeared.
   *
   * One control now: it says it is loading while it is, and starts the moment it can. The native
   * player stays afterwards, because scrubbing back through a voice note is worth having and is
   * not worth reimplementing.
   */
  const audioRef = useRef<HTMLAudioElement>(null);
  const play = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { audioBase64 } = await call<{ audioBase64: string }>({
        t: "note-audio",
        id: note.id,
      });
      const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
      setUrl(URL.createObjectURL(new Blob([bytes], { type: note.audioType ?? "audio/webm" })));
      setShouldPlay(true);
    } catch (err) {
      // A fetch that fails silently leaves a button that looks like it did nothing.
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Started from an effect rather than straight after `setUrl`, because at that point the
   * `<audio>` has no `src` yet — React has not re-rendered. Calling `play()` on it there is a
   * no-op with no error, which is the quietest possible way for this to not work.
   */
  const [shouldPlay, setShouldPlay] = useState(false);
  useEffect(() => {
    if (!shouldPlay || !url) return;
    setShouldPlay(false);
    // Rejection is not fatal: the player is on screen and can be pressed. Reported so that a
    // decode failure does not read as a control that ignores you.
    audioRef.current?.play().catch((err: Error) => setProblem(err.message));
  }, [shouldPlay, url]);

  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await call({ t: "note-delete", id: note.id });
      onChanged();
    } catch (err) {
      // A delete that fails silently leaves the row sitting in its "are you sure?" state, which
      // reads as an unresponsive button rather than as a refusal.
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const spoken = note.audioMs !== undefined;
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(note.createdAt));

  return (
    <div className="stacked-row">
      <div className="what">
        {note.body
          ? <span>{note.body}</span>
          : <span className="faint">Voice note, {Math.round((note.audioMs ?? 0) / 1000)}s</span>}
        <span className="faint">
          {when}
          {note.prompted ? " · prompted" : ""}
        </span>
      </div>
      {problem && <div className="notice bad">{problem}</div>}
      <div className="acts wrap">
        {spoken &&
          (url
            ? <audio ref={audioRef} controls src={url} style={{ height: 32 }} />
            : (
              <button className="btn" type="button" disabled={busy} onClick={() => void play()}>
                {busy ? "Loading…" : `▶ Play ${Math.round((note.audioMs ?? 0) / 1000)}s`}
              </button>
            ))}
        {/* 24.6, 24.3 — deletable, and confirmed, because the recording is the only copy. */}
        {canWrite && (
          <button
            className="link danger"
            type="button"
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
        {/* 25.4 — in a dialog. Inline, the confirming click landed where the first one had been. */}
        {confirming && (
          <Dialog
            title="Delete this note?"
            body={note.audioMs
              ? "The recording goes with it, and it is the only copy — nothing else in this app holds the audio."
              : "There is no undo."}
            confirmLabel="Delete it"
            danger
            busy={busy}
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    </div>
  );
}
