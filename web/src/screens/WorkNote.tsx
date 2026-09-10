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
import { MAX_NOTE_AUDIO_BYTES } from "@worklog/shared/protocol";
import { meterStream, TRACE_LENGTH } from "../levels.ts";
import { useStore } from "../state.tsx";
import { Dialog } from "./Dialog.tsx";
import { clock } from "../format.ts";
import { Sheet } from "./Sheet.tsx";
import { MicPicker } from "./MicPicker.tsx";
import { chooseMic, micConstraints, noteUsedMic } from "../microphone.ts";

/** 5.27 — enough for intelligible speech and nothing more. */
const BITS_PER_SECOND = 20_000;

/**
 * 5.25 — Opus, in whichever container this browser will give it to us in.
 *
 * Chromium records `audio/webm;codecs=opus`, Firefox `audio/ogg;codecs=opus`, Safari `audio/mp4`.
 * Asked in order and the first supported one wins.
 *
 * **Where none is, there is no recorder at all.** This used to fall through to the browser's
 * default on the reasoning that a container the app cannot name might still be one it can store —
 * and in the engine where that actually happens, `deno desktop`'s WebKitGTK, the *constructor*
 * throws `NotSupportedError: The MediaRecorder is unsupported on this platform`. So supporting no
 * type is not a gap in `isTypeSupported`; it is the answer. `desktop/selftest.ts` records both
 * facts against the real engine.
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
  /*
   * 26.9 — what there is to lose.
   *
   * Typed words, a finished recording, and a recording *in progress*. The third was missing: a
   * note dismissed while the microphone was still open closed without asking and threw away
   * however long somebody had been talking. The recording only becomes `recorder.recording` when
   * it stops, so until then there was nothing here to notice.
   */
  const hasContent = () =>
    body.trim().length > 0 || recorder.recording !== undefined || recorder.state === "recording";
  const leave = () => {
    if (hasContent()) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    /*
     * 27.6 — saving finishes the recording rather than refusing because of it.
     *
     * Pressing Save while the microphone was still open was answered with "Type something, or
     * record a few seconds", which was true of that instant and is not a reason to refuse: the
     * person had just recorded several seconds and was asking for them to be kept. Stop stays,
     * for anybody who wants to hear it back first.
     */
    const take = await recorder.finish();
    if (!body.trim() && !take) {
      setProblem("Type something, or record a few seconds.");
      return;
    }
    setSaving(true);
    try {
      await call({
        t: "note-add",
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(take
          ? {
            audioBase64: take.base64,
            audioMs: take.ms,
            audioType: take.type,
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
    <Sheet label="Work note" onDismiss={leave} onInteract={attend}>
      <div className="card stack" style={{ gap: 14 }}>
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
            /* 27.10 — no placeholder. An example of what somebody might write is a suggestion
               about what they were doing, in a box for saying what they were doing. */
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {/* 5.3, 5.23 */}
        <div className="stack" style={{ gap: 8 }}>
          <h3>Or out loud</h3>
          {!recorder.supported
            ? (
              <p className="faint" style={{ margin: 0, fontSize: 13 }}>
                This window cannot record audio. Text still works, and a device that can record — a
                phone, or a browser tab — can add a spoken note to its own.
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
                {
                  /*
                   * 27.7 — the button that says "Record again" records again.
                   *
                   * It discarded, and left you looking at a Record button to press separately —
                   * reported as "it offers Record again and there is no way to record another",
                   * which is what a control that does not do what it says produces. Throwing the
                   * take away is a different intention and now has its own control.
                   */
                }
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    recorder.discard();
                    void recorder.start();
                  }}
                >
                  Record again
                </button>
                <button
                  className="link danger"
                  type="button"
                  onClick={recorder.discard}
                >
                  Discard
                </button>
              </div>
            )
            : (
              <div className="stack" style={{ gap: 8 }}>
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
                {/* 27.5 — which microphone, and the cog for choosing another. */}
                <MicPicker />
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
          body={recorder.state === "recording"
            ? "This is still recording, and nothing has been kept yet. Closing loses it."
            : recorder.recording
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
  /**
   * 27.6 — who to tell when the take is ready.
   *
   * `stop()` returns at once and the recording appears later: `onstop` fires, the chunks are
   * concatenated and base64-encoded, and only then is there something to save. Save had no way to
   * wait for that, so pressing it mid-recording was refused with "there is nothing here" — true of
   * that instant, and not a reason to refuse.
   */
  const takeRef = useRef<((take: Recording | undefined) => void) | undefined>(undefined);

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
      /*
       * 27.5 — through the microphone this device chose, when it chose one.
       *
       * The constraint is `exact`, so a stale choice fails loudly rather than recording through
       * the laptop lid while the screen names a headset. Failing loudly is not the same as
       * refusing to record: the choice is forgotten, the default is used, and the note says which.
       */
      let usedDefault = false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() })
        .catch((err: Error) => {
          if (err.name !== "OverconstrainedError" && err.name !== "NotFoundError") throw err;
          chooseMic(undefined);
          usedDefault = true;
          return navigator.mediaDevices.getUserMedia({ audio: micConstraints(undefined) });
        });
      if (usedDefault) {
        setProblem(
          "The microphone you chose is not available, so this is recording through the default " +
            "one.",
        );
      }
      streamRef.current = stream;
      // 27.33 — which device this actually opened, so the picker can name the default instead of
      // guessing at it. Free: the track is already here and it knows.
      noteUsedMic(stream);
      // 24.5 — something that moves when you speak. Started from the same stream the recorder
      // uses, so a trace that stays flat means the recording is flat too.
      stopMeterRef.current = meterStream(stream, setTrace);
      const mimeType = pickMimeType();
      const media = new MediaRecorder(stream, {
        audioBitsPerSecond: BITS_PER_SECOND,
        ...(mimeType ? { mimeType } : {}),
      });
      /*
       * 5.24 — chunk by chunk, so the size is known while it is still being made.
       *
       * `start()` with no timeslice hands over one blob at the end, which is the last possible
       * moment to discover that it will not fit. The server reads at most `MAX_REQUEST_BYTES` and
       * a note travels as base64 inside the JSON, so speech at this bitrate reaches the limit in
       * about five minutes — and the way that presented was five minutes of talking followed by
       * "request too large", with nothing to do about it but record it again shorter.
       *
       * A chunk a second is enough to stop on time, and the recording that has already been made
       * is kept: it stops, it says why, and everything up to that point is still there to save.
       */
      const chunks: Blob[] = [];
      let bytes = 0;
      media.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        chunks.push(e.data);
        bytes += e.data.size;
        if (bytes >= MAX_NOTE_AUDIO_BYTES && media.state === "recording") {
          setProblem(
            "That is as long a recording as the server will accept, so it stopped there. What " +
              "you have is ready to save.",
          );
          media.stop();
        }
      };
      media.onstop = async () => {
        const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
        release();
        const take: Recording = {
          base64: await base64OfBlob(blob),
          ms: Date.now() - startedRef.current,
          type: blob.type,
          url: URL.createObjectURL(blob),
        };
        setRecording(take);
        setState("idle");
        takeRef.current?.(take);
        takeRef.current = undefined;
      };
      startedRef.current = Date.now();
      setElapsed(0);
      // A chunk a second; see `ondataavailable`.
      media.start(1_000);
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

  /**
   * 27.6 — stop if it is running, and hand back the take either way.
   *
   * What Save needs: the recording as it will be saved, whether it was already finished or is
   * being finished by the act of saving.
   */
  const finish = (): Promise<Recording | undefined> => {
    if (state !== "recording" || !mediaRef.current) return Promise.resolve(recording);
    return new Promise((resolve) => {
      takeRef.current = resolve;
      mediaRef.current?.stop();
    });
  };

  return {
    // Not merely that the class exists: WebKitGTK has the class, supports no container, and
    // throws from the constructor. Offering a Record button there is offering an error message.
    supported: typeof MediaRecorder !== "undefined" && pickMimeType() !== undefined,
    finish,
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

/**
 * 27.46 — named for what it takes, because it is not the shared `toBase64`.
 *
 * That one turns a `Uint8Array` into base64 synchronously. This one reads a `Blob` through a
 * `FileReader`, which is asynchronous and never materialises the bytes — a five-minute recording
 * is most of a megabyte and there is no reason to hold it twice. Two different operations sharing
 * one name is how somebody comes to call the wrong one; the guard in `repo_test.ts` reads the name
 * and would have had to be taught an exception rather than the name being made true.
 */
function base64OfBlob(blob: Blob): Promise<string> {
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
