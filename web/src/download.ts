/**
 * Handing a generated file to the person who asked for it (8.33).
 *
 * **This exists because "generate a PDF" had been generating one onto the server's disk and
 * stopping there.** The server is the right place for the canonical copy (17.11) and the wrong
 * place for the only copy: the frontend that pressed the button is frequently a phone, or a browser
 * tab on a laptop across the room, and neither can open a path in the server's data directory.
 *
 * Two ways down, because the two shells have genuinely different constraints:
 *
 * - **A browser tab** gets an object URL and a synthetic click. Ordinary, and it lands wherever the
 *   browser puts downloads.
 * - **The desktop window** is a `file://` page, where a download has no dependable destination and
 *   in a webview may be silently ignored. So the shell writes the file (8.34) — the same arrangement as
 *   the device key and the device settings, and for the same reason (15.x, 16.1).
 */

import { isDesktop, shell } from "./desktop.ts";

export interface Saved {
  /** Where it went, when that can be said. A browser cannot say. */
  path?: string;
  fileName: string;
}

/** Decode what the wire carries. The protocol is JSON, so bytes travel as base64. */
export function bytesFromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export async function saveFile(
  fileName: string,
  bytes: Uint8Array,
  mime: string,
): Promise<Saved> {
  if (isDesktop()) {
    const path = await shell.saveFile(fileName, btoa(String.fromCharCode(...bytes)));
    return { path, fileName };
  }

  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mime }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked on a later turn: revoking before the browser has started reading the blob cancels the
  // download in some of them, and an object URL is cheap enough that a second's grace costs nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { fileName };
}
