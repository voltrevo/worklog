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
 * The one that will be used, as far as can be told without opening a stream.
 *
 * The stored choice when it is still present; otherwise the first entry, which is what every
 * engine puts its default at and what `getUserMedia` with no `deviceId` will pick.
 */
export function activeMic(mics: Microphone[], chosen = chosenMic()): Microphone | undefined {
  return mics.find((m) => m.deviceId === chosen) ?? mics[0];
}

/**
 * 5.26 — mono, and with the processing that makes speech intelligible rather than pretty; plus
 * whichever device was chosen.
 *
 * `exact`, so a choice is a choice. `ideal` would fall back to the default when the chosen
 * microphone has been unplugged and record through it while the screen said otherwise, which is
 * the one outcome worse than an error. The caller handles `OverconstrainedError` by forgetting the
 * choice and saying so.
 */
export function micConstraints(chosen = chosenMic()): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
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
