/**
 * Mounting, and saying so when it does not.
 *
 * The `onUncaughtError` hook exists because of the desktop window. A `file://` document treats its
 * inline script as opaque, so anything React throws during a render reaches `window.onerror` as
 * `"Script error." @ ?:0` and nothing else — no message, no stack, no file. The shell then sees a
 * loaded page with an empty `#root` and has nothing to report but the shape of the failure.
 *
 * Inside the callback the error is not sanitised. So it is written where `executeJs` can read it,
 * which is the only channel a packaged desktop app has: no console to watch, no devtools to open.
 * In a browser tab this costs one property assignment and changes nothing.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

interface BootRecord {
  errors: string[];
  rejections: string[];
  module: string;
  react?: string;
}

function recordBoot(where: string, error: unknown): void {
  const boot = (globalThis as { __worklogBoot?: BootRecord }).__worklogBoot;
  if (!boot) return; // A browser tab; `inline.mjs` only writes this into the desktop build.
  // Both, because WebKit's `stack` omits the message and the message is the part that names the
  // fault. Recording only one of them turns a five-minute diagnosis into an afternoon.
  const err = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? "(no stack)"}`
    : String(error);
  boot.react = `${where}: ${err}`;
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root to mount into");

createRoot(root, {
  onUncaughtError: (error) => recordBoot("render", error),
  onCaughtError: (error) => recordBoot("boundary", error),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
