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
import { useStore } from "../state.tsx";
import { clock } from "../format.ts";

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
  const { call, refresh } = useStore();
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const recorder = useRecorder();

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
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Work note">
      <div className="card stack" style={{ gap: 14 }}>
        <div className="row between">
          <h2>{prompted ? "What are you working on?" : "Work note"}</h2>
          {/* 5.21 — always available, and it costs nothing. */}
          <button className="link" type="button" onClick={onClose}>
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
              <div className="row">
                <span className="pill bad">● recording {clock(recorder.elapsedMs)}</span>
                <button className="btn" type="button" onClick={() => void recorder.stop()}>
                  Stop
                </button>
              </div>
            )
            : recorder.recording
            ? (
              <div className="row wrap">
                {/* 5.28 — played back before it is even saved. */}
                <audio controls src={recorder.recording.url} style={{ height: 34 }} />
                <button className="link" type="button" onClick={recorder.discard}>
                  Record again
                </button>
              </div>
            )
            : (
              <div className="row">
                <button className="btn" type="button" onClick={() => void recorder.start()}>
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
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
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

  const release = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => () => release(), []);

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setElapsed(Date.now() - startedRef.current), 200);
    return () => clearInterval(id);
  }, [state]);

  const start = async () => {
    setProblem(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 5.26 — mono, and with the processing that makes speech intelligible rather than pretty.
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
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
