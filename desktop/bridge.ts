/**
 * The host half of the desktop bridge (15.x). See `web/src/bridge.ts` for why it exists.
 *
 * In one sentence: `BrowserWindow.bind` exposes nothing to the page in `deno desktop` 2.9.1's
 * webview backend, and does so silently, so the shell drives the page through `executeJs` instead
 * — draining a queue the page owns and answering into it.
 */

/** The subset of `Deno.BrowserWindow` this file needs. `bind` is deliberately absent. */
export interface Window {
  navigate(url: string): void;
  loadUrl?(url: string): void;
  show?(): void;
  executeJs(code: string): Promise<unknown> | unknown;
}

/** Must match `BRIDGE_GLOBAL` in `web/src/bridge.ts`. */
const GLOBAL = "__worklogBridge";

/** Fast enough that a signature feels immediate, slow enough to be free when nothing is happening. */
const POLL_MS = 25;

export type Handlers = Record<string, (args: unknown[]) => unknown | Promise<unknown>>;

interface Queued {
  id: number;
  name: string;
  args: unknown[];
}

/**
 * `executeJs` answers `{ ok, value }` and refuses to marshal anything it cannot represent — a
 * Promise comes back as `Unsupported result type` rather than being awaited. So every snippet
 * below ends in a string or a plain value, and nothing is passed across that is not JSON.
 */
async function evaluate(window: Window, code: string): Promise<unknown> {
  const raw = await window.executeJs(code) as { ok?: boolean; value?: unknown } | undefined;
  if (!raw?.ok) throw new Error(`executeJs refused: ${JSON.stringify(raw?.value)}`);
  return raw.value;
}

/**
 * Drive the page's queue until `stop()` is called.
 *
 * Errors thrown by a handler travel back as a rejection with the message and nothing else: the
 * page has no business seeing a host stack trace, and 16.4's narrowness applies in this direction
 * too.
 */
export function serveBridge(
  window: Window,
  handlers: Handlers,
  onError: (message: string) => void = () => {},
  onFirstCall: (name: string) => void = () => {},
): () => void {
  let running = true;
  let served = false;

  const pump = async () => {
    while (running) {
      try {
        const raw = await evaluate(window, `(globalThis.${GLOBAL}?.drain() ?? "[]")`) as string;
        const queued = JSON.parse(raw) as Queued[];
        for (const req of queued) {
          // Once, and only once. A shell that never says anything is indistinguishable from the
          // one this replaced, which believed it had a bridge and had nothing.
          if (!served) {
            served = true;
            onFirstCall(req.name);
          }
          let ok = true;
          let payload: string;
          try {
            const handler = handlers[req.name];
            if (!handler) throw new Error(`no such bridge call: ${req.name}`);
            payload = JSON.stringify(await handler(req.args) ?? null);
          } catch (err) {
            ok = false;
            payload = (err as Error).message;
          }
          await evaluate(
            window,
            `(globalThis.${GLOBAL}?.settle(${req.id}, ${ok}, ${JSON.stringify(payload)}), "ok")`,
          );
        }
      } catch (err) {
        // A page that has navigated or closed makes `executeJs` fail; that is not fatal to the
        // shell, and a bridge that dies on the first hiccup is worse than one that retries.
        onError((err as Error).message);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  void pump();
  return () => {
    running = false;
  };
}
