/**
 * Writing down what you are working on (section 5).
 *
 * Two ways in and they are the same panel: the **New work note** button (5.4, 5.5, 19.8), and a
 * prompt the server fired while the timer was running (5.6). The only difference is a sentence at
 * the top and a `prompted` flag on what gets saved, because they are the same act — the prompt is
 * a reminder to do the thing the button also does.
 *
 * **A prompt can always be dismissed without answering** (5.21). Nothing is owed: the event is
 * already gone server-side, so closing this is the end of it.
 */

import { useEffect, useRef, useState } from "react";
import { meterStream, TRACE_LENGTH } from "../levels.ts";
import { useStore } from "../state.tsx";
import { Dialog } from "./Dialog.tsx";
import { clock } from "../format.ts";
import { Sheet } from "./Sheet.tsx";

/** 5.27 — enough for intelligible speech and nothing more. */
const BITS_PER_SECOND = 20_000;

/**
 * 5.25 — Opus, in whichever container this browser will give it to us in.
 *
 * Chromium records `audio/webm;codecs=opus`, Firefox `audio/ogg;codecs=opus`, Safari neither. Asked
 * in order and the first supported one wins; if none is, the recorder falls back to the browser's
 * default and the server stores whatever arrives rather than refusing the note.
 */
const PREFERRED = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED.find((t) => MediaRecorder.isTypeSupported(t));
}

export interface WorkNoteProps {
  /** Set when this was opened by a prompt rather than by the button. */
  prompted?: boolean;
  onClose(): void;
}

export function WorkNote({ prompted, onClose }: WorkNoteProps) {
  const { call, refresh, acknowledgePrompt } = useStore();
  /** Only for a prompted note: an ordinary one has no tune to stop. */
  const attend = () => {
    if (prompted) acknowledgePrompt();
  };
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const recorder = useRecorder();

  /**
   * 26.9 — closing a note that has something in it asks first.
   *
   * A note is typed once and there is no draft anywhere: Escape, the backdrop, or a mis-aimed
   * "Not now" and the words are gone with nothing to recover them from. A recording is worse,
   * because it cannot be typed again.
   *
   * Only when there is something to lose. Confirming an empty dialog is a dialog about nothing.
   */
  const hasContent = () => body.trim().length > 0 || recorder.recording !== undefined;
  const leave = () => {
    if (hasContent()) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!body.trim() && !recorder.recording) {
      setProblem("Type something, or record a few seconds.");
      return;
    }
    setSaving(true);
    try {
      await call({
        t: "note-add",
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(recorder.recording
          ? {
            audioBase64: recorder.recording.base64,
            audioMs: recorder.recording.ms,
            audioType: recorder.recording.type,
          }
          : {}),
        ...(prompted ? { prompted: true } : {}),
      });
      await refresh();
      onClose();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet label="Work note" onDismiss={leave}>
      {
        /*
        26.7 — touching the dialog silences the tune.

        Not the sheet's own opening focus, which happens without anybody doing anything: an alarm
        that stops because it appeared is not an alarm. A pointer or a key is somebody attending
        to it, and from that moment the sound is noise over the thing it was summoning them to.
      */
      }
      <div
        className="card stack"
        style={{ gap: 14 }}
        onPointerDown={attend}
        onKeyDown={attend}
      >
        <div className="row between">
          <h2>{prompted ? "What are you working on?" : "Work note"}</h2>
          {/* 5.21 — always available, and it costs nothing. */}
          <button className="link" type="button" onClick={leave}>
            {prompted ? "Not now" : "Close"}
          </button>
        </div>

        {prompted && (
          <p className="muted" style={{ margin: 0 }}>
            A quick line about the last little while. Skip it if you would rather keep going —
            nothing is waiting on this.
          </p>
        )}

        {/* 5.2, 5.22 */}
        <label className="field">
          In writing
          <textarea
            rows={4}
            value={body}
            autoFocus
            placeholder="Finished the cage-sum pruning; started on the invoice layout."
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {/* 5.3, 5.23 */}
        <div className="stack" style={{ gap: 8 }}>
          <h3>Or out loud</h3>
          {!recorder.supported
            ? (
              <p className="faint" style={{ margin: 0, fontSize: 13 }}>
                This browser will not record audio here. Text still works.
              </p>
            )
            : recorder.state === "recording"
            ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row">
                  <span className="pill bad">
                    ● recording {clock(recorder.elapsedMs)}
                  </span>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void recorder.stop()}
                  >
                    Stop
                  </button>
                </div>
                {/* 24.5 — the part that moves when you speak. */}
                <Trace levels={recorder.trace} />
              </div>
            )
            : recorder.recording
            ? (
              <div className="row wrap">
                {/* 5.28 — played back before it is even saved. */}
                <audio
                  controls
                  src={recorder.recording.url}
                  style={{ height: 34 }}
                />
                <button
                  className="link danger"
                  type="button"
                  onClick={recorder.discard}
                >
                  Record again
                </button>
              </div>
            )
            : (
              <div className="row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => void recorder.start()}
                >
                  ● Record
                </button>
                <span className="faint" style={{ fontSize: 12 }}>
                  Mono Opus, about {Math.round(BITS_PER_SECOND / 1000)}{" "}
                  kbit/s — small enough to keep forever.
                </span>
              </div>
            )}
          {recorder.problem && <div className="notice warn">{recorder.problem}</div>}
        </div>

        {problem && <div className="notice bad">{problem}</div>}

        <div className="row">
          <button
            className="btn primary"
            type="button"
            disabled={saving}
            onClick={() => void save()}
          >
            Save note
          </button>
          <button className="btn" type="button" onClick={leave}>
            Cancel
          </button>
        </div>
      </div>

      {/* 26.9 — over the note, not instead of it, so the words are still visible behind. */}
      {confirmDiscard && (
        <Dialog
          title="Throw this note away?"
          body={recorder.recording
            ? "There is a recording here, and it is not saved anywhere else. Closing loses it."
            : "What you have typed is not saved anywhere else. Closing loses it."}
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

interface Recording {
  base64: string;
  ms: number;
  type: string;
  url: string;
}

/**
 * Recording, as a hook, because the cleanup matters more than the recording does.
 *
 * A `getUserMedia` stream keeps the microphone light on until every track is stopped, so the tracks
 * are stopped when the recorder stops *and* when the component unmounts — a note dismissed
 * mid-recording must not leave the microphone open.
 */
function useRecorder() {
  const [state, setState] = useState<"idle" | "recording">("idle");
  const [recording, setRecording] = useState<Recording>();
  const [problem, setProblem] = useState<string>();
  const [elapsedMs, setElapsed] = useState(0);
  const mediaRef = useRef<MediaRecorder>(null);
  const streamRef = useRef<MediaStream>(null);
  const startedRef = useRef(0);
  /** 24.5 — the live trace, and the handle that stops it. */
  const [trace, setTrace] = useState<number[]>([]);
  const stopMeterRef = useRef<(() => void) | undefined>(undefined);

  const release = () => {
    stopMeterRef.current?.();
    stopMeterRef.current = undefined;
    setTrace([]);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => () => release(), []);

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(
      () => setElapsed(Date.now() - startedRef.current),
      200,
    );
    return () => clearInterval(id);
  }, [state]);

  const start = async () => {
    setProblem(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 5.26 — mono, and with the processing that makes speech intelligible rather than pretty.
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      // 24.5 — something that moves when you speak. Started from the same stream the recorder
      // uses, so a trace that stays flat means the recording is flat too.
      stopMeterRef.current = meterStream(stream, setTrace);
      const mimeType = pickMimeType();
      const media = new MediaRecorder(stream, {
        audioBitsPerSecond: BITS_PER_SECOND,
        ...(mimeType ? { mimeType } : {}),
      });
      const chunks: Blob[] = [];
      media.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      media.onstop = async () => {
        const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
        release();
        setRecording({
          base64: await toBase64(blob),
          ms: Date.now() - startedRef.current,
          type: blob.type,
          url: URL.createObjectURL(blob),
        });
        setState("idle");
      };
      startedRef.current = Date.now();
      setElapsed(0);
      media.start();
      mediaRef.current = media;
      setState("recording");
    } catch (err) {
      release();
      setProblem(
        (err as Error).name === "NotAllowedError"
          ? "The microphone was not allowed. Text still works."
          : `Could not start recording: ${(err as Error).message}`,
      );
    }
  };

  const stop = () => mediaRef.current?.stop();

  const discard = () => {
    if (recording) URL.revokeObjectURL(recording.url);
    setRecording(undefined);
  };

  return {
    supported: typeof MediaRecorder !== "undefined",
    trace,
    state,
    recording,
    problem,
    elapsedMs,
    start,
    stop,
    discard,
  };
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // `result` is a data URL, and only the part after the comma is the payload.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The live input trace (24.5).
 *
 * Bars rather than a line, and drawn with plain elements rather than a canvas: there are a hundred
 * and twenty of them, they change once a frame, and a canvas would need its own resize handling to
 * do the same job. Fixed-width slots so the trace scrolls rather than squashing as it fills.
 *
 * The floor of 2% is deliberate. A bar of zero height is invisible, and a row of nothing looks
 * like a component that failed rather than a microphone hearing silence — which is the exact
 * ambiguity this is here to remove.
 */
function Trace({ levels }: { levels: number[] }) {
  const slots = Array.from(
    { length: TRACE_LENGTH },
    (_, i) => levels[i - (TRACE_LENGTH - levels.length)] ?? 0,
  );
  return (
    <div className="trace" aria-hidden="true">
      {slots.map((level, i) => <span key={i} style={{ height: `${Math.max(2, level * 100)}%` }} />)}
    </div>
  );
}
