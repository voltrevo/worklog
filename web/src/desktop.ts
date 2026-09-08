/**
 * The page's side of the Deno Desktop window, when there is one (section 15).
 *
 * The window control is what the desktop *adds* (15.1). The signer and the settings store are what
 * it *replaces*, because a `file://` page has an opaque origin and no dependable storage of its
 * own — so the key lives in a file the operating system protects and the page asks for signatures
 * rather than holding anything.
 *
 * **How "am I the desktop?" is answered, and why it changed.** It used to be `typeof
 * window.__worklogSign === "function"` — the shell bound functions onto the page, and their
 * presence was the signal. `BrowserWindow.bind` turns out to expose nothing at all in this
 * runtime, silently, so that test was permanently false *inside the desktop window*: the app
 * decided it was a browser tab and fell back to keeping a key in a `file://` origin's IndexedDB,
 * which is precisely the storage the shell exists to replace. Detection by "did a global arrive?"
 * fails in the direction that hides the failure.
 *
 * So it now asks which *build* this is, which is a fact settled before anything runs:
 * `inline.mjs` marks `desktop.html`, the Pages `index.html` is unmarked, and calls go over the
 * queue in `bridge.ts`. 15.5 still follows from the answer rather than being a rule to remember.
 *
 * Nothing here touches the server (15.6, 15.7, 16.2, 16.3). There is no request to make.
 */

import type { Signer } from "@worklog/shared/client";
import { bridge, desktopBuild } from "./bridge.ts";

export function isDesktop(): boolean {
  return desktopBuild();
}

/** Every call the shell answers. The names are matched by `desktop/main.ts`'s handler table. */
const call = {
  setAlwaysOnTop: (on: boolean) => bridge().call("setAlwaysOnTop", [on]) as Promise<boolean>,
  publicKey: () => bridge().call("publicKey") as Promise<string>,
  sign: (messageBase64: string) => bridge().call("sign", [messageBase64]) as Promise<string>,
  settingsGet: () => bridge().call("settingsGet") as Promise<string>,
  settingsSet: (json: string) => bridge().call("settingsSet", [json]) as Promise<boolean>,
  /** 8.33 — write a generated file where the person can find it, and say where that was. */
  saveFile: (fileName: string, base64: string) =>
    bridge().call("saveFile", [fileName, base64]) as Promise<string>,
};

export { call as shell };

// ------------------------------------------------------------------ always on top

const ALWAYS_ON_TOP = "worklog.alwaysOnTop";

/** 15.3 — remembered on this device, and only this one. */
export function loadAlwaysOnTop(): boolean {
  return deviceStorage().get(ALWAYS_ON_TOP) === "1";
}

/**
 * 15.2–15.4 — store it and apply it now.
 *
 * Stored whether or not the window accepts it, so a platform that cannot honour the request still
 * remembers the preference for one that can. That is also why it is reapplied at startup.
 */
export async function setAlwaysOnTop(on: boolean): Promise<void> {
  deviceStorage().set(ALWAYS_ON_TOP, on ? "1" : "0");
  try {
    await call.setAlwaysOnTop(on);
  } catch {
    // "where supported" (15.4). A window manager that ignores the hint is not an error, and there
    // is nobody to report it to.
  }
}

// ------------------------------------------------------------------ signing

/** 13.2, 13.4 — a signer backed by the shell's key file, which the page cannot read. */
export function desktopSigner(): Signer {
  return {
    publicKey: async () => fromBase64(await call.publicKey()),
    sign: async (message) => fromBase64(await call.sign(toBase64(message))),
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ device-local settings

export interface DeviceStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

let cached: Record<string, string> | undefined;

/**
 * `localStorage` in a tab; the shell's settings file in the desktop window.
 *
 * Reads are synchronous because every caller is a render path, so the desktop side keeps an
 * in-memory copy loaded once by `primeDeviceStorage` and writes through. A write that has not
 * reached disk yet is still correct in the running app, and the only thing lost to a crash in that
 * window is a preference.
 */
export function deviceStorage(): DeviceStorage {
  if (!isDesktop()) {
    return {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
      remove: (k) => localStorage.removeItem(k),
    };
  }
  const held = cached ??= {};
  const flush = () => void call.settingsSet(JSON.stringify(held)).catch(() => {});
  return {
    get: (k) => (k in held ? held[k]! : null),
    set: (k, v) => {
      held[k] = v;
      flush();
    },
    remove: (k) => {
      delete held[k];
      flush();
    },
  };
}

/** Load the shell's settings before the app reads any. A no-op in a browser tab. */
export async function primeDeviceStorage(): Promise<void> {
  if (!isDesktop()) return;
  try {
    cached = JSON.parse(await call.settingsGet()) as Record<string, string>;
  } catch {
    cached = {};
  }
}
