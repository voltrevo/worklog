/**
 * Live input level from a microphone stream (24.5).
 *
 * **A recording with no feedback is a recording you cannot trust.** The panel showed a timer
 * counting up, which advances identically whether the microphone is working, muted, or pointed at
 * a wall. The failure that matters is speaking for five minutes and finding out afterwards, and a
 * clock cannot tell you about it — only something that moves when *you* move can.
 *
 * So this reads the analyser once per frame and keeps a short rolling history, which the panel
 * draws as bars. The history is what makes it a waveform rather than a level meter, and the
 * difference matters: a single bar jittering near zero looks similar whether it is picking up a
 * voice or a fan, where a trace that rises and falls with speech is unmistakable.
 *
 * Kept out of the component because `AudioContext` and `requestAnimationFrame` in a `useEffect`
 * are most of the code, and because the arithmetic — RMS to a 0..1 bar height — is worth being
 * able to test on its own.
 */

/** How many samples the trace holds. At ~60fps this is about two seconds of history. */
export const TRACE_LENGTH = 120;

/**
 * Root-mean-square of a byte time-domain buffer, as 0..1.
 *
 * `getByteTimeDomainData` centres silence on 128, so the deviation from that is the signal.
 */
export function rms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const centred = (s - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * RMS to a bar height, on the same reasoning as `gain.ts`: ears are logarithmic.
 *
 * A linear meter spends most of its travel on levels too loud for speech and leaves ordinary talk
 * pinned near the floor — which would reproduce the exact problem this is here to solve, a display
 * that barely moves while somebody is speaking. 50 dB of range puts a normal voice around the
 * middle.
 */
export const RANGE_DB = 50;

export function barHeight(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, 1 + db / RANGE_DB));
}

export interface Meter {
  /** Newest last. Shorter than `TRACE_LENGTH` until the trace fills. */
  trace: number[];
  stop(): void;
}

/**
 * Watch a stream until `stop()`.
 *
 * `onFrame` is called with a fresh trace each animation frame. The caller owns the stream — this
 * closes only what it made, because the recorder needs the stream to go on recording.
 */
export function meterStream(
  stream: MediaStream,
  onFrame: (trace: number[]) => void,
): () => void {
  const Ctx = globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};

  const context = new Ctx();
  const analyser = context.createAnalyser();
  // Small enough to respond within a frame, large enough that the RMS is not noise.
  analyser.fftSize = 1024;

  /*
   * 25.36 — the analyser has to reach the destination, even though nobody is meant to hear it.
   *
   * This was `createMediaStreamSource(stream).connect(analyser)` and nothing else, which looks
   * complete and is not: Web Audio renders the part of the graph that reaches the output, and an
   * analyser hanging off the end reaches nothing. So it was pulled only when the graph happened to
   * be running for some other reason, and `getByteTimeDomainData` filled the buffer with 128s the
   * rest of the time — a trace that is flat with occasional bursts, which is exactly what was
   * reported and exactly what an unplugged microphone would also look like.
   *
   * The route to the destination goes through a gain of zero, because the alternative is the
   * microphone coming out of the speakers a few milliseconds later, into the microphone.
   */
  const source = context.createMediaStreamSource(stream);
  const silence = context.createGain();
  silence.gain.value = 0;
  source.connect(analyser);
  analyser.connect(silence);
  silence.connect(context.destination);

  // An AudioContext created without a gesture starts suspended, and a suspended context renders
  // nothing at all — the same symptom again, from the other direction. Recording begins from a
  // click, so this normally resolves at once; when it does not, there is nothing useful to say
  // and the trace simply stays flat, which is the honest outcome.
  if (context.state === "suspended") void context.resume().catch(() => {});

  const samples = new Uint8Array(analyser.fftSize);
  const trace: number[] = [];
  let running = true;

  const tick = () => {
    if (!running) return;
    analyser.getByteTimeDomainData(samples);
    trace.push(barHeight(rms(samples)));
    if (trace.length > TRACE_LENGTH) trace.shift();
    onFrame([...trace]);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return () => {
    running = false;
    // Disconnected before closing: `close()` alone leaves the stream's source node attached to a
    // context that is going away, and the browser keeps the microphone's "in use" indicator lit.
    source.disconnect();
    analyser.disconnect();
    silence.disconnect();
    void context.close().catch(() => {});
  };
}
