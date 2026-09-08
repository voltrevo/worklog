/**
 * The bridge to the Deno Desktop window, when there is one (section 15).
 *
 * **The frontend does not know which build it is.** There is one bundle (1.14, 1.19) — the same
 * files on GitHub Pages and inside the desktop window — so instead of a build flag the page looks
 * for functions the shell bound onto `window`. Present means desktop; absent means a browser tab.
 * 15.5 is then a consequence of how the control is detected rather than a rule to remember.
 *
 * The shell binds four things and they divide neatly in two. The window control is what the
 * desktop *adds* (15.1). The signer and the settings store are what it *replaces*, because a
 * `file://` page has an opaque origin and no dependable storage of its own — so the key lives in a
 * file the operating system protects and the page asks for signatures rather than holding
 * anything.
 *
 * Nothing here touches the server (15.6, 15.7, 16.2, 16.3). There is no request to make.
 */

import type { Signer } from "@worklog/shared/client";

interface DesktopBindings {
  __worklogSetAlwaysOnTop(on: boolean): Promise<boolean>;
  __worklogIsAlwaysOnTop(): Promise<boolean>;
  __worklogPublicKey(): Promise<string>;
  __worklogSign(messageBase64: string): Promise<string>;
  __worklogSettingsGet(): Promise<string>;
  __worklogSettingsSet(json: string): Promise<boolean>;
}

function bindings(): Partial<DesktopBindings> {
  return globalThis as unknown as Partial<DesktopBindings>;
}

export function isDesktop(): boolean {
  return typeof bindings().__worklogSign === "function";
}

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
    await bindings().__worklogSetAlwaysOnTop?.(on);
  } catch {
    // "where supported" (15.4). A window manager that ignores the hint is not an error, and there
    // is nobody to report it to.
  }
}

// ------------------------------------------------------------------ signing

/** 13.2, 13.4 — a signer backed by the shell's key file, which the page cannot read. */
export function desktopSigner(): Signer {
  const api = bindings();
  return {
    publicKey: async () => fromBase64(await api.__worklogPublicKey!()),
    sign: async (message) => fromBase64(await api.__worklogSign!(toBase64(message))),
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
  const api = bindings();
  const held = cached ??= {};
  const flush = () => void api.__worklogSettingsSet?.(JSON.stringify(held)).catch(() => {});
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
    cached = JSON.parse(await bindings().__worklogSettingsGet!()) as Record<
      string,
      string
    >;
  } catch {
    cached = {};
  }
}
