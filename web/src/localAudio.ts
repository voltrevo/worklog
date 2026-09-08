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

const DB_NAME = "worklog";
const STORE = "audio";
const FILE_KEY = "loop";
const ENABLED_KEY = "worklog.audio.enabled";
const VOLUME_KEY = "worklog.audio.volume";

export { gainFor, labelFor, RANGE_DB } from "./gain.ts";

// ------------------------------------------------------------------ the stored file

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      // Version 2 adds this store beside the device key's, which version 1 created.
      if (!req.result.objectStoreNames.contains("device")) req.result.createObjectStore("device");
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    })
  );
}

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
  await run("readwrite", (s) => s.put(stored, FILE_KEY));
  return stored;
}

export function loadLoop(): Promise<StoredLoop | undefined> {
  return run<StoredLoop | undefined>("readonly", (s) => s.get(FILE_KEY));
}

export async function clearLoop(): Promise<void> {
  await run("readwrite", (s) => s.delete(FILE_KEY));
}

export function loadEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

export function saveEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
}

export function loadVolume(): number {
  const raw = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
}

export function saveVolume(position: number): void {
  localStorage.setItem(VOLUME_KEY, String(position));
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
  #position = 0;

  /** Swap in a file, or `undefined` to unload. Stops anything playing. */
  async load(loop: StoredLoop | undefined): Promise<void> {
    this.stop();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = undefined;
    this.#audio = undefined;
    if (!loop) return;

    this.#url = URL.createObjectURL(new Blob([loop.bytes], { type: loop.type }));
    const audio = new Audio(this.#url);
    audio.loop = true; // 14.12 — continuously, with no gap and nothing to press
    audio.preload = "auto";
    this.#audio = audio;
    await Promise.resolve();
  }

  setVolume(position: number): void {
    this.#position = position;
    if (this.#gain && this.#context) {
      // Ramped rather than stepped, because a jump in gain is an audible click.
      this.#gain.gain.setTargetAtTime(gainFor(position), this.#context.currentTime, 0.02);
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
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
    await audio.play().catch(() => {});
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
