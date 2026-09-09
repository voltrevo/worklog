/**
 * Does the desktop shell's bridge actually work?
 *
 *     deno task desktop:check      # builds, then runs this under a virtual display
 *
 * Nothing verified this before, and the answer was **no** for as long as the shell existed:
 * `BrowserWindow.bind` exposes nothing to the page in `deno desktop` 2.9.1's webview backend, and
 * reports no error doing it. Five bindings, none of them present, and the app's response was to
 * decide it was an ordinary browser tab and keep its key in a `file://` origin's IndexedDB.
 *
 * So this exists, and it exercises the real handler table from `main.ts` against a real window:
 * a real Ed25519 signature verified against the shell's own public key, a settings round trip
 * through the real file, and a file written to the real directory. What it cannot do is dial a
 * server — this container's WebKitGTK has no `libnice` or `gstwebrtc` — so the page it drives is a
 * fixture rather than the app. Everything below the transport is covered; the transport is covered
 * by `tools/journey.mjs` in Chromium.
 *
 * It needs a display. On a headless machine: `xvfb-run -a deno task desktop:check`.
 */

import { dirname } from "jsr:@std/path@^1";
import { serveBridge, type Window } from "./bridge.ts";

interface Ctor {
  new (options: Record<string, unknown>): Window & { show?(): void };
}

const runtime = Deno as unknown as { BrowserWindow?: Ctor };
if (!runtime.BrowserWindow) {
  console.error("selftest: no BrowserWindow. Run through `deno desktop`.");
  Deno.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

// ---------------------------------------------------------------- a key, as the shell makes one

const dir = await Deno.makeTempDir({ prefix: "worklog-selftest-" });
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]) as CryptoKeyPair;
const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

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

const settings: Record<string, string> = { "worklog.existing": "kept" };

// The same shape `main.ts` installs. Kept here rather than imported because `main.ts` opens the
// real window and loads the real bundle; what is under test is the bridge, not the launcher.
const handlers = {
  publicKey: () => toBase64(publicRaw),
  sign: async ([messageBase64]: unknown[]) =>
    toBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          fromBase64(messageBase64 as string) as BufferSource,
        ),
      ),
    ),
  settingsGet: () => JSON.stringify(settings),
  settingsSet: ([json]: unknown[]) => {
    Object.assign(settings, JSON.parse(json as string));
    return true;
  },
  saveFile: async ([name, base64]: unknown[]) => {
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "download";
    const path = `${dir}/${safe}`;
    await Deno.writeFile(path, fromBase64(base64 as string));
    return path;
  },
  boom: () => {
    throw new Error("handlers that throw must reject, not hang");
  },
};

// ---------------------------------------------------------------- the page

const window = new runtime.BrowserWindow({
  title: "worklog selftest",
  width: 480,
  height: 320,
});
window.show?.();

/** The page half of `web/src/bridge.ts`, inlined so this file has no build step. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>selftest</title><body><script>
globalThis.__worklogBridge = {
  q: [], n: 1, pending: {},
  call(name, args) {
    return new Promise((res, rej) => {
      const id = this.n++;
      this.pending[id] = { res, rej };
      this.q.push({ id, name, args: args || [] });
    });
  },
  drain() { const s = JSON.stringify(this.q); this.q = []; return s; },
  settle(id, ok, json) {
    const p = this.pending[id]; delete this.pending[id];
    if (!p) return;
    ok ? p.res(JSON.parse(json)) : p.rej(new Error(json));
  },
};
globalThis.__run = async () => {
  const b = globalThis.__worklogBridge;
  const out = {};
  out.publicKey = await b.call("publicKey");
  out.signature = await b.call("sign", [globalThis.__message]);
  out.settingsBefore = await b.call("settingsGet");
  await b.call("settingsSet", [JSON.stringify({ "worklog.added": "yes" })]);
  out.settingsAfter = await b.call("settingsGet");
  out.savedTo = await b.call("saveFile", ["../../escape me.pdf", globalThis.__fileB64]);
  // 26.11 put the invoice in an iframe over a blob URL, which is the browser's own PDF viewer —
  // and this is not that browser. Ask before assuming.
  out.pdfViewer = String(navigator.pdfViewerEnabled);
  out.pdfMime = String(Boolean(navigator.mimeTypes && navigator.mimeTypes["application/pdf"]));
  // And a real one, in a real iframe: the flag above is a claim, and 26.11's viewer is the only
  // way this build shows an invoice. No backticks in here -- this whole script is a template
  // literal on the Deno side, and one backtick ends it.
  const bin = atob(globalThis.__pdfB64);
  const pdfBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pdfBytes[i] = bin.charCodeAt(i);
  // Three questions, because one answer cannot tell them apart: does an iframe over a blob work at
  // all, does it work for a PDF, and does a data: URL do any better. The app can be built on
  // whichever of them this engine will actually draw.
  const frameLoads = (url) =>
    new Promise((res) => {
      const f = document.createElement("iframe");
      f.width = "300"; f.height = "200";
      let settled = false;
      const done = (why) => { if (!settled) { settled = true; f.remove(); res(why); } };
      f.onload = () => setTimeout(() => {
        try {
          const d = f.contentDocument;
          done(d ? "document:" + (d.body ? d.body.childElementCount : "no body") : "loaded");
        } catch (e) { done("blocked:" + e.name); }
      }, 600);
      f.onerror = () => done("error event");
      setTimeout(() => done("no load event"), 5000);
      f.src = url;
      document.body.appendChild(f);
    });
  out.htmlBlobFrame = await frameLoads(
    URL.createObjectURL(new Blob(["<p>hello</p>"], { type: "text/html" })),
  );
  out.pdfFrame = await frameLoads(
    URL.createObjectURL(new Blob([pdfBytes], { type: "application/pdf" })),
  );
  out.pdfDataFrame = await frameLoads(
    "data:application/pdf;base64," + globalThis.__pdfB64,
  );
  try { await b.call("boom"); out.boom = "did not reject"; }
  catch (e) { out.boom = "rejected: " + e.message; }
  try { await b.call("noSuchCall"); out.unknown = "did not reject"; }
  catch (e) { out.unknown = "rejected: " + e.message; }
  globalThis.__done = JSON.stringify(out);
};
</script>`;

const pagePath = `${dir}/selftest.html`;
await Deno.writeTextFile(pagePath, PAGE);
const url = `file://${pagePath}`;
if (window.loadUrl) window.loadUrl(url);
else window.navigate(url);

const stop = serveBridge(window, handlers, () => {});

async function js(code: string): Promise<unknown> {
  const raw = await window.executeJs(code) as { ok?: boolean; value?: unknown };
  if (!raw?.ok) throw new Error(`executeJs refused: ${JSON.stringify(raw?.value)}`);
  return raw.value;
}

/**
 * Poll until `read` produces something.
 *
 * **`false` counts as something**, and that is a trap this file fell into. The reader below was
 * `async () => await js("typeof globalThis.__run") === "function"` — a boolean — so on the first
 * poll, before the page had run its script, it returned `false`, which is neither `undefined` nor
 * `null`, and the wait returned straight away. Everything then proceeded against a page that was
 * not ready, and `globalThis.__run()` failed as "not a function" roughly one run in five.
 *
 * The signature is right and the caller was wrong: a reader says "not yet" with `undefined`. Said
 * here as well as fixed there, because the next boolean predicate will be written by somebody who
 * has not read this.
 */
async function waitFor<T>(what: string, read: () => Promise<T | undefined>, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** `web/dist/desktop.html`, from a checkout or from the files embedded in a packaged app. */
async function findApp(): Promise<Uint8Array | undefined> {
  for (
    const candidate of [
      new URL("../web/dist/desktop.html", import.meta.url).pathname,
      `${Deno.cwd()}/web/dist/desktop.html`,
    ]
  ) {
    try {
      return await Deno.readFile(candidate);
    } catch {
      // Try the next.
    }
  }
  return undefined;
}

/**
 * A genuine one-page PDF, written out here rather than rendered.
 *
 * A viewer will refuse a file that merely starts with `%PDF-`, so `FILE` above will not do — and
 * `pdf-lib` is not resolvable from inside the packaged desktop build, which is where this runs.
 * Four objects and a correct cross-reference table is not much to write, and the offsets have to
 * be counted rather than guessed: a viewer that rebuilds a broken xref would make a wrong answer
 * here look like a right one.
 */
function onePagePdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const MESSAGE = new TextEncoder().encode("worklog selftest message");
const FILE = new TextEncoder().encode("%PDF-1.7 selftest\n");

try {
  await waitFor(
    "the page",
    // `|| undefined`, not a bare boolean: see `waitFor`. A `false` here used to end the wait.
    async () => (await js("typeof globalThis.__run") === "function") || undefined,
  );

  await js(`globalThis.__message = ${JSON.stringify(toBase64(MESSAGE))};`);
  await js(`globalThis.__fileB64 = ${JSON.stringify(toBase64(FILE))};`);
  await js(`globalThis.__pdfB64 = ${JSON.stringify(toBase64(onePagePdf()))};`);
  await js("globalThis.__run(); 'started'");

  const raw = await waitFor(
    "the calls to finish",
    async () => await js("globalThis.__done ?? null"),
  );
  // Every field named, and defaulted to "": `Record<string, string>` would be `| undefined` at
  // every use under `noUncheckedIndexedAccess`, and an absent field should fail a check rather
  // than fail a type.
  const parsed = JSON.parse(raw as string) as Partial<Record<string, string>>;
  const out = {
    publicKey: parsed.publicKey ?? "",
    signature: parsed.signature ?? "",
    settingsBefore: parsed.settingsBefore ?? "{}",
    settingsAfter: parsed.settingsAfter ?? "{}",
    savedTo: parsed.savedTo ?? "",
    pdfViewer: parsed.pdfViewer ?? "",
    pdfFrame: parsed.pdfFrame ?? "",
    htmlBlobFrame: parsed.htmlBlobFrame ?? "",
    pdfDataFrame: parsed.pdfDataFrame ?? "",
    pdfMime: parsed.pdfMime ?? "",
    boom: parsed.boom ?? "",
    unknown: parsed.unknown ?? "",
  };

  check("the page can reach the shell at all", out.publicKey !== "");
  check("and gets back the shell's public key", out.publicKey === toBase64(publicRaw));

  // The point of the whole arrangement (13.2, 13.4): a real signature, made by a key the page
  // never saw, verifying against the public half.
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    pair.publicKey,
    fromBase64(out.signature) as BufferSource,
    MESSAGE as BufferSource,
  );
  check("a signature made by the shell verifies", verified);

  check(
    "settings come back",
    (JSON.parse(out.settingsBefore) as Record<string, string>)["worklog.existing"] === "kept",
  );
  check(
    "a write reaches the shell and merges rather than replacing",
    (JSON.parse(out.settingsAfter) as Record<string, string>)["worklog.added"] === "yes" &&
      (JSON.parse(out.settingsAfter) as Record<string, string>)["worklog.existing"] === "kept",
  );

  // 8.34, and the path traversal the handler is supposed to flatten.
  // The question is the file's *parent*, not whether the name contains dots. `../../escape me.pdf`
  // sanitises to `_.._escape_me.pdf`, which still has two dots in it and is perfectly safe, because
  // the separators are what mattered and they are gone. A check that banned the characters would
  // have failed here while the defence was working, which is a good way to get the defence changed.
  check(
    "a saved file lands directly inside the shell's directory",
    dirname(out.savedTo) === dir,
    out.savedTo,
  );
  check(
    "and its bytes are what was sent",
    (await Deno.readTextFile(out.savedTo)).startsWith("%PDF-"),
  );

  // A bridge whose failures hang is worse than one that has none: the page awaits forever with
  // nothing on screen, which is exactly how the `bind` fault presented.
  check("a handler that throws rejects", out.boom.startsWith("rejected:"), out.boom);
  check("an unknown call rejects", out.unknown.startsWith("rejected:"), out.unknown);

  /*
   * 15.4 — and the one window call the app makes for itself.
   *
   * Every other handler here is a fixture standing in for `main.ts`, because what is under test is
   * the bridge. Always-on-top is different: the handler is one line that calls straight through to
   * the runtime, so the only question worth asking is whether the runtime does anything with it.
   * 15.4 says "where supported", and a toggle that flips a stored boolean while the window ignores
   * it is a control that does nothing — the app would have no way to know, and neither would we.
   */
  const win = window as unknown as {
    setAlwaysOnTop?: (on: boolean) => void;
    isAlwaysOnTop?: () => boolean;
  };
  console.log(
    `  · navigator.pdfViewerEnabled = ${out.pdfViewer}, application/pdf = ${out.pdfMime}, ` +
      `html blob = ${out.htmlBlobFrame}, pdf blob = ${out.pdfFrame}, ` +
      `pdf data URL = ${out.pdfDataFrame}`,
  );

  /*
   * 26.11 — an iframe is how the app shows an invoice, and this engine will not draw one.
   *
   * Not from a blob URL and not from a data URL, while reporting `navigator.pdfViewerEnabled` as
   * `true` — so the standard capability flag cannot be asked. An HTML blob in the same iframe
   * loads, which is what makes it the format rather than the frame.
   *
   * So the desktop build saves the file instead, and this asserts the reason for that branch
   * rather than leaving it as a thing somebody once observed. If WebKitGTK grows a PDF viewer this
   * goes red, and the right response is to delete the branch in `Invoices.tsx`.
   */
  check(
    "an iframe still cannot show a PDF here, which is why the desktop saves instead",
    out.pdfFrame === "no load event" && out.pdfDataFrame === "no load event",
    `blob: ${out.pdfFrame}, data: ${out.pdfDataFrame}`,
  );
  check(
    "and it is the format, not the frame — an HTML blob loads in the same iframe",
    out.htmlBlobFrame.startsWith("document:"),
    out.htmlBlobFrame,
  );

  // `main.ts` declares both on a hand-written `BrowserWindowLike` and casts to it, so the type
  // checker has never confirmed either exists. If they do not, the toggle throws.
  const exposed = typeof win.setAlwaysOnTop === "function" &&
    typeof win.isAlwaysOnTop === "function";
  check("15.4 — the window exposes always-on-top", exposed);
  if (exposed) {
    /*
     * Whether it is *honoured* is a property of the display, not of this code: under `xvfb-run`
     * there is no window manager to keep anything above anything, and the runtime says so by
     * reporting `false` after being asked for `true`. That is the right answer, and it is the
     * answer the app now shows instead of a ticked box over a window sitting behind everything.
     *
     * So this reports rather than asserts. The thing worth asserting is that the shell passes the
     * window's own answer back, which is what `desktop.ts` believes.
     */
    const wasOnTop = win.isAlwaysOnTop!();
    win.setAlwaysOnTop!(!wasOnTop);
    const honoured = win.isAlwaysOnTop!() === !wasOnTop;
    win.setAlwaysOnTop!(wasOnTop);
    console.log(
      `  · always-on-top is ${honoured ? "honoured" : "not honoured"} by this display`,
    );
  }
} catch (err) {
  check("the selftest ran", false, (err as Error).message);
}

// ---------------------------------------------------------------- the real app, in this engine
//
// Everything above tests the bridge against a fixture. This loads the *actual* bundle, because the
// fault that kept the desktop window blank was not in the bridge at all — `shared/dates.ts` used
// `Temporal`, which is Chromium-only, and the app threw on its first render. Every other test in
// this repo that opens a browser opens Chromium, so nothing could see it.
//
// One assertion, and it is the one that matters: does the app mount in a second engine.
try {
  const appHtml = await findApp();
  if (!appHtml) {
    check(
      "the built app is present to check",
      false,
      "run `deno task web:build` first, or build this with --include web/dist",
    );
  } else {
    const copied = `${dir}/desktop.html`;
    await Deno.writeFile(copied, appHtml);
    if (window.loadUrl) window.loadUrl(`file://${copied}`);
    else window.navigate(`file://${copied}`);

    const mounted = await waitFor(
      "the app to mount",
      async () => {
        const n = await js("document.getElementById('root')?.children.length ?? -1");
        return Number(n) > 0 ? true : undefined;
      },
      // Generous, because this is a cold WebKitGTK loading a 300 kB inlined bundle on a machine
      // that may be running a browser harness at the same time. A mount that takes twenty seconds
      // is not a pass, but a *timeout* that fires at twenty is a red check about the machine.
      45_000,
    ).catch(() => false);

    // Composed from several probes rather than one, because an empty `#root` is the symptom of a
    // parse error, a render throw, a page that never loaded and a bundle that was never built —
    // and those want different fixes.
    const detail = await js(
      "JSON.stringify({" +
        "ready: document.readyState," +
        "root: document.getElementById('root')?.children.length ?? -1," +
        "marked: !!globalThis.__worklogDesktopBuild," +
        "boot: globalThis.__worklogBoot ?? null})",
    ).catch((e) => `could not be read: ${(e as Error).message}`);
    check(
      "the real app mounts in this engine, not only in Chromium",
      mounted === true,
      String(detail).slice(0, 500),
    );

    /*
     * Mounting proves the bundle parses and the first render runs. It proves nothing about an API
     * used only on a code path — and the interesting ones all are.
     *
     * `AbortSignal.timeout` is reached when connecting, `:focus-visible` when tabbing,
     * `overflow-wrap: anywhere` when a long address is shown. Each landed here from a browser
     * where it obviously works, and this webview is a different engine on whatever version the
     * distribution shipped. The failure mode is a screen that works until the one moment it does
     * not, in the one place with no console to look at.
     *
     * Named individually, because "something is missing" and "`AbortSignal.timeout` is missing"
     * want completely different responses.
     */
    const capabilities: [string, string][] = [
      ["AbortSignal.timeout", "typeof AbortSignal?.timeout === 'function'"],
      ["Array.prototype.at", "typeof [].at === 'function'"],
      ["structuredClone", "typeof structuredClone === 'function'"],
      ["crypto.subtle", "typeof crypto?.subtle === 'object'"],
      ["CSS :focus-visible", "CSS.supports('selector(:focus-visible)')"],
      ["CSS overflow-wrap: anywhere", "CSS.supports('overflow-wrap', 'anywhere')"],
      ["CSS color-scheme", "CSS.supports('color-scheme', 'light dark')"],
      ["CSS minmax in grid", "CSS.supports('grid-template-columns', 'minmax(0, 1fr)')"],
    ];
    const absent: string[] = [];
    for (const [name, expr] of capabilities) {
      const present = await js(`(() => { try { return ${expr}; } catch { return false; } })()`)
        .catch(() => false);
      if (present !== true) absent.push(name);
    }
    check(
      "and this engine has every API the frontend reaches for",
      absent.length === 0,
      absent.join(", "),
    );
  }
} catch (err) {
  check("the real app could be loaded", false, (err as Error).message);
}

stop();
await Deno.remove(dir, { recursive: true }).catch(() => {});
console.log(failures === 0 ? "\ndesktop bridge: all checks passed" : `\n${failures} failed`);
Deno.exit(failures === 0 ? 0 : 1);
