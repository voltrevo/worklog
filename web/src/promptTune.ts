/**
 * The sound a prompt makes (25.39, 25.40).
 *
 * **It was two notes, once.** A quarter of a second, played at the moment the prompt arrived, and
 * then silence — so the whole mechanism worked only if you happened to be within earshot at that
 * instant and not typing. A prompt whose entire purpose is to reach somebody looking at something
 * else cannot be a sound you had to be waiting for.
 *
 * So it is a short phrase that repeats until the prompt is answered or dismissed, and gives up
 * after a minute, because a noise that never stops is one somebody turns off permanently.
 *
 * **Everything is scheduled on the audio clock, up front.** This is 25.40 and it is the part worth
 * being deliberate about: a background tab has its `setTimeout` throttled to about once a minute,
 * so a loop driven by timers would fire the first phrase and then, at best, one more — which is
 * indistinguishable from the bug this replaces, and only in the case that matters. `AudioContext`
 * keeps its own clock and honours `start(when)` for events queued long in advance, so the entire
 * minute is handed over at once and the tab can be as inactive as it likes.
 *
 * Synthesised rather than fetched, as before: a bundle that ships an audio file to say "hello?" is
 * a bundle carrying an audio file, and a prompt that needs a network round trip to be heard is one
 * that goes unheard exactly when the connection is bad.
 */

/** A rising phrase, deliberately unlike a notification: two of these are recognisable as *this*. */
export const PHRASE_HZ = [660, 880, 990, 880];

/** How long each note sounds, and the step between the starts of consecutive notes. */
export const NOTE_S = 0.14;
export const STEP_S = 0.18;

/** The gap between one phrase and the next, measured start to start. */
export const REPEAT_EVERY_S = 3.5;

/** 25.39 — up to a minute, then it stops on its own. */
export const MAX_SECONDS = 60;

export interface Note {
  /** Seconds from the start of the tune. */
  at: number;
  hz: number;
}

/**
 * Every note in the tune, as offsets.
 *
 * Pure, and separate from the Web Audio calls, because the timing is the part with a claim in it —
 * "repeating for up to a minute" is an assertion about this list and about nothing that requires a
 * speaker to check.
 */
export function tuneSchedule(maxSeconds: number = MAX_SECONDS): Note[] {
  const notes: Note[] = [];
  for (let phraseAt = 0; phraseAt < maxSeconds; phraseAt += REPEAT_EVERY_S) {
    for (const [i, hz] of PHRASE_HZ.entries()) {
      const at = phraseAt + i * STEP_S;
      // A phrase that would be cut off by the limit is not started. Half a phrase reads as a
      // fault rather than as an ending.
      if (phraseAt + (PHRASE_HZ.length - 1) * STEP_S + NOTE_S > maxSeconds) return notes;
      notes.push({ at, hz });
    }
  }
  return notes;
}

/**
 * Play it. Returns the way to stop.
 *
 * Failing silently is fine and deliberate: no audio context, no permission, a muted tab — none of
 * those is an error, and the panel appears on screen either way.
 */
export function playPromptTune(maxSeconds: number = MAX_SECONDS): () => void {
  const Ctx = globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};

  let audio: AudioContext;
  try {
    audio = new Ctx();
  } catch {
    return () => {};
  }

  // Suspended is what an autoplay policy looks like from here. Resuming without a gesture may be
  // refused; if it is, the queued notes simply never sound, which is the same outcome as a muted
  // tab and not worth a message on a panel that is already asking a question.
  if (audio.state === "suspended") void audio.resume().catch(() => {});

  const master = audio.createGain();
  master.gain.value = 0.12;
  master.connect(audio.destination);

  const started = audio.currentTime + 0.05;
  const stops: OscillatorNode[] = [];
  for (const note of tuneSchedule(maxSeconds)) {
    const at = started + note.at;
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = note.hz;
    // A hard start and stop on a sine is a click. The envelope is short enough not to soften the
    // rhythm and long enough to remove it.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(1, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S);
    osc.connect(env);
    env.connect(master);
    osc.start(at);
    osc.stop(at + NOTE_S + 0.02);
    stops.push(osc);
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    // Every oscillator is already scheduled, so closing the context is what silences the ones that
    // have not sounded yet. `stop()` on each first, because a context that is closed while nodes
    // are running clicks on some platforms.
    for (const osc of stops) {
      try {
        osc.stop();
      } catch {
        // Already stopped, or never started. Neither matters here.
      }
    }
    void audio.close().catch(() => {});
  };
}
