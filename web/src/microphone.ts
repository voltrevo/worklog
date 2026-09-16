/**
 * Which microphone a spoken note will use, and how this device remembers the answer (27.5).
 *
 * Device-local, like everything else in section 16: a microphone is a fact about the machine you
 * are sitting at, not about the account, and syncing it to the server would mean a phone recording
 * through a laptop's device id.
 *
 * **The labels are the awkward part.** `enumerateDevices` lists the microphones whether or not you
 * have ever allowed recording, but their `label` is the empty string until permission has been
 * granted for this origin — the count is not private, the names are. So this can only name what
 * will be used *after* the first recording, which is why 27.5 says "when that is known", and why
 * `reveal()` exists: it opens a stream for as long as it takes the browser to grant the origin, and
 * stops it again.
 */

import { deviceStorage } from "./desktop.ts";

const KEY = "worklog.microphone";

export interface Microphone {
  deviceId: string;
  /** Empty until this origin has been granted the microphone once. */
  label: string;
}

/** The stored choice, if there is one. Not checked against what is plugged in. */
export function chosenMic(): string | undefined {
  return deviceStorage().get(KEY) ?? undefined;
}

/** `undefined` means "whatever this machine calls its default", which is also the initial state. */
export function chooseMic(deviceId: string | undefined): void {
  if (deviceId) deviceStorage().set(KEY, deviceId);
  else deviceStorage().remove(KEY);
}

/** Every microphone this browser will admit to, in the browser's own order. */
export async function listMics(): Promise<Microphone[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    // A browser that refuses to enumerate is one that will refuse to record, and the record path
    // has the error message worth showing. Here it is just an empty list and no picker.
    return [];
  }
}

/**
 * The one that will be used — only when that is actually known (27.33).
 *
 * `undefined` means "this device's default, whichever that is", and the picker says exactly that
 * rather than naming a microphone.
 *
 * **It used to return `mics[0]`**, on the reasoning that every engine lists its default first.
 * Chromium does; the order is not specified and Firefox does not promise it. So the line under the
 * Record button read "Microphone: Yeti Stereo" with confidence, about a device the browser had
 * never said it would use — the same shape of fault as a default interval, arrived at from a
 * plausible assumption rather than an invented number.
 *
 * Once a recording has run there is no guessing left: `noteUsedMic` records what the track
 * actually opened, and that is a fact.
 */
export function activeMic(mics: Microphone[], chosen = chosenMic()): Microphone | undefined {
  return mics.find((m) => m.deviceId === chosen);
}

/**
 * The device a stream actually opened, remembered for the rest of this sitting.
 *
 * `getUserMedia` resolves the default for us, and the track it hands back says which one it
 * picked. That answer costs nothing — the microphone is already open — and it is the only way to
 * name the default without either asking for the microphone on sight or guessing.
 *
 * Deliberately not stored: it is an observation about now, not a preference, and writing it down
 * would turn "whatever this device defaults to" into a choice nobody made.
 */
let observed: string | undefined;

export function noteUsedMic(stream: MediaStream): void {
  observed = stream.getAudioTracks()[0]?.getSettings().deviceId ?? undefined;
}

export function usedMic(): string | undefined {
  return observed;
}

/**
 * 5.26 — mono; plus whichever device was chosen, and none of the browser's voice processing.
 *
 * `exact`, so a choice is a choice. `ideal` would fall back to the default when the chosen
 * microphone has been unplugged and record through it while the screen said otherwise, which is
 * the one outcome worse than an error. The caller handles `OverconstrainedError` by forgetting the
 * choice and saying so.
 *
 * **5.32 — the three processing flags are off, and the loop is why.** Reported as background audio
 * destroying a voice note's quality *while the playback was in headphones and reaching the
 * microphone not at all*, which is the detail that names the cause. Echo cancellation subtracts a
 * filtered copy of what this page is **playing** from what the microphone hears: it keys off the
 * render stream, not off any sound in the room. With headphones there is no echo path to model, so
 * the adaptive filter converges on nothing and gouges the speech it was meant to be protecting.
 * The loop is playing during exactly the recordings this feature exists for (14.12), so the one
 * case AEC ruins is the common one.
 *
 * Noise suppression goes for a second reason and automatic gain control for a third, because
 * turning off only the one that was named would have fixed a third of it: NS is tuned for
 * *stationary* noise and music is the opposite of stationary, and AGC rides the level against the
 * loop, which is what makes a recording pump. AGC was never set here at all — it was the browser's
 * default, which on Chromium is on, so it was a value nobody in this codebase had chosen (27.33).
 *
 * **What this costs, stated rather than discovered**: recording on speakers rather than headphones
 * now captures the loop as well as the voice. That is the case AEC was protecting and it is a real
 * regression for it — but a note with the loop faintly under it is legible, and 14.18–14.23 mean
 * the person chose that volume. A destroyed note is not legible at any volume.
 *
 * None of this was ever required. 5.26 asks for "low-bitrate mono audio sufficient for intelligible
 * speech" — `channelCount: 1` and `BITS_PER_SECOND` are what answer it. The processing arrived with
 * the feature under a comment citing 5.26 and was read as settled ever since.
 */
export function micConstraints(chosen = chosenMic()): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    ...(chosen ? { deviceId: { exact: chosen } } : {}),
  };
}

/**
 * Ask for the microphone and immediately give it back, so the labels appear.
 *
 * Resolves `false` if permission was refused, which is not an error here: the picker says so and
 * the list stays as it was.
 */
export async function reveal(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}
