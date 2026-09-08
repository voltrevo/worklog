/**
 * The page half of the desktop bridge (15.x).
 *
 * ## Why this is not `BrowserWindow.bind`
 *
 * It was. `bind(name, fn)` is documented to expose `fn` to the page as `window[name]`, and in
 * `deno desktop` 2.9.1 with the webview backend **it exposes nothing at all**. The call returns
 * `undefined`, no error is raised, and `typeof window[name]` is `"undefined"` for every name shape
 * tried — prefixed, unprefixed, before navigation, after navigation, after a reload, on `file://`
 * and on `about:blank`. The page is demonstrably alive throughout; `executeJs("1+1")` answers `2`.
 *
 * That silence is what makes it dangerous. The desktop shell called `bind` five times, believed it
 * had a signing bridge, and got nothing; `isDesktop()` then read `typeof __worklogSign` as
 * `"undefined"`, said "not the desktop", and fell back to the browser signer — which stores a key
 * in a `file://` origin's IndexedDB, the exact storage the shell exists to avoid. A missing feature
 * that presents as a *different working configuration* is worse than one that throws.
 *
 * ## What replaces it
 *
 * `executeJs` works, and it is the host→page direction. So the page owns a queue, the host drains
 * it by evaluating `drain()`, and answers by evaluating `settle()`. Polling, which for signing and
 * reading a settings file is entirely adequate — a signature is a keystroke's worth of latency and
 * nothing here is in a render path.
 *
 * The queue lives in the page rather than being injected by the host, which removes the startup
 * race: the app can call `bridge.call(...)` before the host's first poll, and it simply waits.
 *
 * `desktopBuild()` is how the app knows it is in a window at all, and it is a fact about *which
 * HTML file this is* rather than a probe for a global that may not have arrived yet. `inline.mjs`
 * sets the flag when it builds `desktop.html`; the Pages `index.html` never has it.
 */

/** What `desktop.html` carries and `index.html` does not. */
export function desktopBuild(): boolean {
  return (globalThis as { __worklogDesktopBuild?: boolean }).__worklogDesktopBuild === true;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Queued {
  id: number;
  name: string;
  args: unknown[];
}

export interface Bridge {
  call(name: string, args?: unknown[]): Promise<unknown>;
  /** Read and clear the queue. Called by the host through `executeJs`, never by the app. */
  drain(): string;
  /** Deliver an answer. Called by the host through `executeJs`, never by the app. */
  settle(id: number, ok: boolean, json: string): void;
}

/**
 * A call the host never answers rejects rather than hanging.
 *
 * Ten seconds is far longer than any of these operations, and the alternative — an await that
 * never returns — is a blank screen with no message, which is how the original fault presented.
 */
const TIMEOUT_MS = 10_000;

function create(): Bridge {
  const pending = new Map<number, Pending>();
  let queue: Queued[] = [];
  let next = 1;

  return {
    call(name, args = []) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        queue.push({ id, name, args });
        setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new Error(`the desktop shell did not answer ${name}`));
        }, TIMEOUT_MS);
      });
    },
    drain() {
      const out = JSON.stringify(queue);
      queue = [];
      return out;
    },
    settle(id, ok, json) {
      const p = pending.get(id);
      if (!p) return; // Already timed out, or answered twice.
      pending.delete(id);
      if (ok) p.resolve(JSON.parse(json));
      else p.reject(new Error(json));
    },
  };
}

/**
 * The single bridge, on `globalThis` under a name the host also knows.
 *
 * A module-level singleton would be invisible to `executeJs`, which evaluates in the page's global
 * scope and cannot see module bindings.
 */
export function bridge(): Bridge {
  const g = globalThis as { __worklogBridge?: Bridge };
  return (g.__worklogBridge ??= create());
}

/** Exported for the test; the name is shared with `desktop/bridge.ts` and must not drift. */
export const BRIDGE_GLOBAL = "__worklogBridge";
