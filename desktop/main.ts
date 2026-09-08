/**
 * Worklog as a desktop window (1.1, 1.6, section 15).
 *
 *     deno task desktop            # run it
 *     deno task desktop:build      # package it
 *
 * **It is the same frontend.** The window loads `web/dist` — the identical bundle GitHub Pages
 * gets — so 1.14 and 1.19 hold with no second build of anything. What the desktop adds is two
 * things a tab cannot have: a window that stays on top, and a device key the operating system
 * protects rather than the page.
 *
 * ## Why there is no local web server
 *
 * The obvious shape for this is a loopback HTTP server: a real origin, so `localStorage` and
 * IndexedDB behave, and a `fetch` for the bridge. It does not work. **Inside a `deno desktop` app
 * an HTTP listener accepts nothing** — `Deno.serve` calls `onListen`, and every connection is
 * refused, from inside the process and out, on the main thread and in a worker. Measured three
 * ways before believing it.
 *
 * So the window loads a `file://` URL and the bridge is `BrowserWindow.bind`, which exposes a
 * function the page can call directly. That turns out to be the better arrangement anyway, because
 * of what a `file://` origin cannot store.
 *
 * ## The device key, and the storage that follows from it
 *
 * A `file://` page gets an opaque or per-path origin, so IndexedDB is usually refused and
 * `localStorage` is not somewhere to rely on. Rather than fight that, the shell owns both:
 *
 * - **The key never enters the page.** It is generated here, kept in `device-key.json` with
 *   `0600` permissions, and used through a bound `signBytes` — so 13.4's "never send the private
 *   key" and 20.5's "device-local" hold more strongly here than in a browser, where the key at
 *   least exists in the tab's storage.
 * - **Settings are a small JSON file** beside it, reached through bound get and set. That is the
 *   server address (22.3), the always-on-top preference (15.3) and the audio settings — all of
 *   which 16.1 and 16.2 require to stay on the device, and none of which this file sends anywhere.
 *
 * The only network this process opens is the window's own — and it is built **without
 * `--allow-net`**, so 15.6, 15.7 and 16.3 are enforced by the runtime rather than by this file
 * being careful. The grants it does take are `read`, `write` and `env`, for the device files and
 * for finding where they go.
 *
 * A packaged app has no terminal, so a permission *prompt* does not fail — it hangs. The first
 * build without those flags started, found its bundle, and stopped dead on the `Deno.env.get`
 * below with nowhere to ask.
 */

import { dirname, join } from "jsr:@std/path@^1";
import { type Handlers, serveBridge } from "./bridge.ts";

interface BrowserWindowLike {
  setAlwaysOnTop(on: boolean): void;
  isAlwaysOnTop(): boolean;
  setTitle(title: string): void;
  navigate(url: string): void;
  loadUrl?(url: string): void;
  /**
   * Present, and does nothing. Kept in this interface as a warning rather than deleted: the
   * obvious way to add a host function is to reach for it, and in this runtime that produces a
   * shell that looks wired up and is not. Use `desktop/bridge.ts`.
   */
  bind(name: string, fn: (...args: never[]) => unknown): void;
  executeJs(code: string): Promise<unknown> | unknown;
}

/** Everything the shell keeps for this device, in one file. */
interface DeviceFile {
  /** Raw Ed25519 keys, base64. Held here precisely so that the page never has them. */
  publicKey: string;
  privateKeyPkcs8: string;
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

/**
 * Where this device's files live: the OS's config directory, or `./.worklog-desktop`.
 *
 * A packaged app must not write beside its own executable — that may be read-only, and on macOS it
 * is inside the bundle.
 */
function dataDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  const base = Deno.env.get("XDG_CONFIG_HOME") ??
    (Deno.build.os === "darwin" && home
      ? join(home, "Library", "Application Support")
      : undefined) ??
    (home ? join(home, ".config") : undefined);
  return base ? join(base, "worklog") : join(Deno.cwd(), ".worklog-desktop");
}

async function loadOrCreateKey(path: string): Promise<{ file: DeviceFile; key: CryptoKey }> {
  try {
    const file = JSON.parse(await Deno.readTextFile(path)) as DeviceFile;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      fromBase64(file.privateKeyPkcs8) as BufferSource,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return { file, key };
  } catch {
    // No key yet, or one this build cannot read. Either way, this device starts again — which the
    // server treats as a new device asking for access, rather than as a broken one.
  }

  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const file: DeviceFile = {
    publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKeyPkcs8: toBase64(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
  };
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(file));
  // 20.5 — readable by this user and nobody else. Windows has no mode; there it is the profile
  // directory's own protection, which is the same protection the browser's storage would have had.
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);

  // Re-imported non-extractable, so from here on even this process cannot read it back out.
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(file.privateKeyPkcs8) as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { file, key };
}

async function loadSettings(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Where `web/dist` is, whether run from a checkout or from a packaged app. */
async function findDist(): Promise<string | undefined> {
  const candidates = [
    new URL("../web/dist", import.meta.url).pathname,
    join(Deno.cwd(), "web/dist"),
  ];
  for (const candidate of candidates) {
    try {
      // `desktop.html` rather than `index.html`: see `web/inline.mjs`. A `file://` page cannot
      // load an ES module by `src`, so the desktop uses the inlined build.
      await Deno.stat(join(candidate, "desktop.html"));
      return candidate;
    } catch {
      // Try the next.
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const dist = await findDist();
  if (!dist) {
    console.error("worklog: web/dist/desktop.html is missing. Run `deno task web:build`.");
    Deno.exit(1);
  }

  const dir = dataDir();
  const keyPath = join(dir, "device-key.json");
  const settingsPath = join(dir, "settings.json");
  const { file: device, key } = await loadOrCreateKey(keyPath);
  const settings = await loadSettings(settingsPath);

  const runtime = Deno as unknown as {
    BrowserWindow?: new (options: Record<string, unknown>) => BrowserWindowLike;
  };
  if (!runtime.BrowserWindow) {
    console.error("worklog: no BrowserWindow here. This entry is meant for `deno desktop`.");
    Deno.exit(1);
  }

  const window = new runtime.BrowserWindow({
    title: "Worklog",
    width: 1180,
    height: 860,
    resizable: true,
    // Starts ordinary; the page reapplies the stored preference once it loads, so the setting has
    // exactly one home and it is the device's file rather than this call.
    alwaysOnTop: false,
  });

  // 15.1, 15.4 — the whole of what the desktop adds to the window.
  //
  // Through `serveBridge` rather than `window.bind`, which exposes nothing to the page in this
  // runtime and says nothing about it. See `desktop/bridge.ts`.
  const handlers: Handlers = {
    setAlwaysOnTop: ([on]) => {
      window.setAlwaysOnTop(Boolean(on));
      settings["worklog.alwaysOnTop"] = on ? "1" : "0";
      void persist(settingsPath, settings);
      return window.isAlwaysOnTop();
    },
    isAlwaysOnTop: () => window.isAlwaysOnTop(),

    // 13.2, 13.4 — the page can ask for a signature and can never ask for the key.
    publicKey: () => device.publicKey,
    sign: async ([messageBase64]) =>
      toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "Ed25519" },
            key,
            fromBase64(messageBase64 as string) as BufferSource,
          ),
        ),
      ),

    // 16.1, 16.2, 22.3 — device-local settings, because a `file://` page has nowhere of its own.
    settingsGet: () => JSON.stringify(settings),
    settingsSet: ([json]) => {
      Object.assign(settings, JSON.parse(json as string) as Record<string, string>);
      void persist(settingsPath, settings);
      return true;
    },

    // 8.34 — a `file://` page's own download has no dependable destination and a webview may drop
    // it silently, so the shell writes the file. Beside the device's other files, which is
    // somewhere a person can be told about in one sentence.
    saveFile: async ([fileName, base64]) => {
      // The name comes from the server, but it lands on *this* machine's filesystem, so it is
      // treated as untrusted here too rather than only there: basename, and nothing that climbs.
      const safe = String(fileName).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") ||
        "download";
      const into = join(dir, "files");
      await Deno.mkdir(into, { recursive: true });
      const path = join(into, safe);
      await Deno.writeFile(path, fromBase64(base64 as string));
      console.log(`worklog: wrote ${path}`);
      return path;
    },
  };

  // ------------------------------------------------------------ getting the page onto real disk
  //
  // A packaged app's `web/dist` is *embedded*: `Deno.readFile` can see it, and the webview cannot.
  // Navigating straight to `file://<embedded path>/desktop.html` silently leaves the window on
  // `about:blank` — the process is healthy, the log is cheerful, and the app is a grey rectangle.
  // That was the shipped behaviour, and nothing said so because nothing asked the page what it
  // was.
  //
  // So the shell copies the page out to somewhere the webview can actually open. This costs one
  // write and works identically from a checkout, and it is only bearable because `inline.mjs`
  // makes `desktop.html` a *single* self-contained file — there are no assets to chase.
  const html = await Deno.readFile(join(dist, "desktop.html"));
  const pagePath = join(dir, "desktop.html");
  await Deno.writeFile(pagePath, html);

  const url = `file://${pagePath}`;
  if (window.loadUrl) window.loadUrl(url);
  else window.navigate(url);

  // After the navigation, because the queue the pump drains belongs to the page and a page that
  // has not loaded has none. `serveBridge` tolerates that gap rather than depending on the timing.
  serveBridge(
    window,
    handlers,
    (message) => console.error(`worklog: bridge: ${message}`),
    (name) => console.log(`worklog: bridge live, page called ${name}`),
  );

  // Say whether the page actually loaded.
  //
  // A window that opens with nothing in it is this shell's oldest failure mode -- the `file://`
  // module problem produced exactly that, and so did a bridge that bound nothing. In both cases
  // the process looked healthy and printed a cheerful line. So: ask the page what it is, and if it
  // cannot answer, say so on the way past rather than leaving a blank rectangle to interpret.
  void (async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const answer = await window.executeJs(
          "document.readyState + '|' + (globalThis.__worklogDesktopBuild ? 'marked' : 'unmarked') " +
            "+ '|' + document.title + '|' + location.href " +
            "+ '|root=' + (document.getElementById('root')?.children.length ?? -1) " +
            "+ '|bridge=' + (globalThis.__worklogBridge ? 'yes' : 'no') " +
            "+ '|' + (globalThis.__worklogBootError || '')",
        ) as { ok?: boolean; value?: unknown };
        if (!answer?.ok) continue;
        const [state, marked, title, href, root, hasBridge, bootError] = String(answer.value)
          .split("|");
        if (state !== "complete") continue;
        console.log(
          `worklog: page loaded (${marked}) title=${title} ${root} ${hasBridge} href=${href}`,
        );
        if (bootError) console.error(`worklog: the page failed to start: ${bootError}`);
        if (marked !== "marked") {
          console.error(
            "worklog: this page is not the desktop build, so it will not use the shell's key or " +
              "settings. Run `deno task web:build` and rebuild.",
          );
        }
        return;
      } catch {
        // Not up yet, or gone. The loop decides.
      }
    }
    console.error(
      `worklog: the page at ${url} never finished loading. The window is open and empty.`,
    );
  })();

  console.log(`worklog: window open, device ${device.publicKey.slice(0, 12)}…, files in ${dir}`);
}

async function persist(path: string, settings: Record<string, string>): Promise<void> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(settings, null, 2));
  } catch (err) {
    // A settings file that cannot be written is a preference that does not survive a restart. It
    // is not worth interrupting the person over, and there is nowhere to report it to — the server
    // must not learn any of this exists.
    console.error(`worklog: could not write ${path}: ${(err as Error).message}`);
  }
}

if (import.meta.main) await main();
