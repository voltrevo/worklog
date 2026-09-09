/**
 * One looping file, while the timer runs, on this device only (section 14).
 *
 * **The server never learns this exists** (14.3–14.5, 16.1, 16.3). The file, the setting, the
 * volume and the fact that anything is configured at all stay in this browser's storage; the only
 * thing crossing the boundary is in the other direction — the authoritative timer state, which is
 * what starts and stops playback (16.6). Two devices can be enabled, disabled, loud and silent
 * independently and neither the server nor the other one can tell (14.16, 14.17).
 *
 * **The volume control is in decibels, and zero is silence.** That curve is `gain.ts`, on its own
 * and free of browser APIs so the test suite can hold it — it is the part of section 14 with a
 * right answer and a silent failure mode.
 *
 * There is deliberately no play, no pause and no seek (14.9–14.11). It is one file, and it is on
 * or off.
 */

import { gainFor } from "./gain.ts";
import { deviceStorage } from "./desktop.ts";
// One opener for the whole frontend; this module and `deviceKeys.ts` used to open the same
// database at different versions, which locked the device out of its own key. See `idb.ts`.
import { run } from "./idb.ts";

const STORE = "audio";
const FILE_KEY = "loop";
const ENABLED_KEY = "worklog.audio.enabled";
const VOLUME_KEY = "worklog.audio.volume";

export { gainFor, labelFor, RANGE_DB } from "./gain.ts";

// ------------------------------------------------------------------ the stored file

export interface StoredLoop {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

/** 14.7 — the file is copied in, so moving or deleting the original does not break anything. */
export async function saveLoop(file: File): Promise<StoredLoop> {
  const stored: StoredLoop = {
    name: file.name,
    type: file.type || "audio/mpeg",
    bytes: await file.arrayBuffer(),
  };
  await run(STORE, "readwrite", (s) => s.put(stored, FILE_KEY));
  return stored;
}

export function loadLoop(): Promise<StoredLoop | undefined> {
  return run<StoredLoop | undefined>(STORE, "readonly", (s) => s.get(FILE_KEY));
}

export async function clearLoop(): Promise<void> {
  await run(STORE, "readwrite", (s) => s.delete(FILE_KEY));
}

export function loadEnabled(): boolean {
  return deviceStorage().get(ENABLED_KEY) === "1";
}

export function saveEnabled(on: boolean): void {
  deviceStorage().set(ENABLED_KEY, on ? "1" : "0");
}

export function loadVolume(): number {
  const raw = Number(deviceStorage().get(VOLUME_KEY));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
}

export function saveVolume(position: number): void {
  deviceStorage().set(VOLUME_KEY, String(position));
}

// ------------------------------------------------------------------ playing it

/**
 * The player.
 *
 * An `<audio>` element through a `GainNode` rather than `element.volume`: 14.18 wants the level
 * independent of the system's, and a `GainNode` is a multiplier this app owns. It also puts the dB
 * curve somewhere real instead of leaving it to the element's own linear scale.
 */
export class LoopPlayer {
  #audio?: HTMLAudioElement;
  #context?: AudioContext;
  #gain?: GainNode;
  #url?: string;
  #blocked = false;
  #position = 0;

  /** Swap in a file, or `undefined` to unload. Stops anything playing. */
  async load(loop: StoredLoop | undefined): Promise<void> {
    this.stop();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = undefined;
    this.#audio = undefined;
    if (!loop) return;

    this.#url = URL.createObjectURL(
      new Blob([loop.bytes], { type: loop.type }),
    );
    const audio = new Audio(this.#url);
    audio.loop = true; // 14.12 — continuously, with no gap and nothing to press
    audio.preload = "auto";
    this.#audio = audio;
    await Promise.resolve();
  }

  setVolume(position: number): void {
    this.#position = position;
    // 25.21 — applied to whatever is playing now, not only at the next start. The ramp is what
    // makes a change mid-playback a fade rather than a click.
    if (this.#gain && this.#context) {
      // Ramped rather than stepped, because a jump in gain is an audible click.
      this.#gain.gain.setTargetAtTime(
        gainFor(position),
        this.#context.currentTime,
        0.02,
      );
    }
  }

  /**
   * 14.14, 14.15 — start from the beginning.
   *
   * Rewinding is deliberate: a new work session should sound like a new one, and resuming a loop
   * from wherever it happened to stop is the kind of detail that makes a room feel unchanged when
   * something has in fact changed.
   */
  async start(): Promise<void> {
    const audio = this.#audio;
    if (!audio) return;

    if (!this.#context) {
      const Ctx = globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      this.#context = new Ctx();
      this.#gain = this.#context.createGain();
      this.#gain.connect(this.#context.destination);
      this.#context.createMediaElementSource(audio).connect(this.#gain);
    }
    this.setVolume(this.#position);
    // A context created before a user gesture starts suspended; this is a no-op once running.
    await this.#context.resume().catch(() => {});
    audio.currentTime = 0;

    /*
     * 25.19 — a blocked start is reported, not discarded.
     *
     * This was `await audio.play().catch(() => {})`. Browsers reject `play()` when nothing the
     * user did caused it, and the timer starting on *another device* is the clearest possible
     * case of that. So the loop silently never played: no error, no element to click, nothing to
     * find. It began working the moment a click happened to unlock the context, and stopped again
     * on the next reload, which is exactly what an autoplay policy looks like from the outside.
     *
     * `blocked` is what the UI reads to offer a start control.
     */
    try {
      await audio.play();
      this.#blocked = false;
    } catch (err) {
      this.#blocked = (err as Error)?.name === "NotAllowedError";
      if (!this.#blocked) throw err;
    }
  }

  /**
   * True when the last start was refused by the autoplay policy (25.19).
   *
   * Distinct from "not playing": nothing is playing when no timer is running either, and those two
   * want opposite things on screen.
   */
  get blocked(): boolean {
    return this.#blocked;
  }

  /** 14.13 */
  stop(): void {
    this.#audio?.pause();
  }

  get playing(): boolean {
    return this.#audio !== undefined && !this.#audio.paused;
  }

  dispose(): void {
    this.stop();
    if (this.#url) URL.revokeObjectURL(this.#url);
    void this.#context?.close().catch(() => {});
    this.#context = undefined;
    this.#gain = undefined;
    this.#audio = undefined;
    this.#url = undefined;
  }
}

/**
 * The one player, shared by the component that follows the timer and the settings card.
 *
 * They were separate instances, which is why the volume slider only took effect at the next start
 * (25.21), why removing the file left the old one playing (25.22), and why previewing the loop was
 * impossible without starting a timer (25.23). There is one pair of speakers; there should be one
 * player.
 *
 * `subscribe` exists because the player's state — playing, blocked — changes for reasons no React
 * tree caused: a timer starting on another device, an autoplay refusal. A component that only
 * re-rendered on its own events would show the wrong thing.
 */
let shared: LoopPlayer | undefined;
const listeners = new Set<() => void>();

export function player(): LoopPlayer {
  return (shared ??= new LoopPlayer());
}

export function notifyAudioChanged(): void {
  for (const l of listeners) l();
}

export function subscribeAudio(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
