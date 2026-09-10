/**
 * The scaffolding both browser-driven tools stand on.
 *
 * A real seeded database, the real KPS listener, the real production bundle over plain HTTP, and
 * browser contexts that are genuinely separate devices. Nothing here mocks anything: the point of
 * both `screenshots.mjs` and `journey.mjs` is that if the transport, the protocol, the signing or
 * either shell is broken, they fail.
 *
 * It is a module rather than a copy because the two tools want the same eight-step setup and
 * disagree only about what to do once it is standing up — one takes pictures, the other drives the
 * write path and checks what came back.
 *
 * `CHROME_PATH` must point at a Chromium. See `requireBrowser` for why that is checked rather than
 * left to Playwright.
 */

import { spawn } from "node:child_process";
import { serverFlags } from "./serverFlags.mjs";
import { createServer } from "node:http";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

export const root = new URL("..", import.meta.url).pathname;
export const dist = join(root, "web/dist");

/** 1440×1000 is the desktop mockups' shape; 390×844 is a phone. 23.2's two presentations. */
export const DESKTOP = { width: 1440, height: 1000 };
export const MOBILE = { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Check `CHROME_PATH` before anything else, because Playwright's own diagnosis is worse than none.
 *
 * Handed `executablePath: undefined` it falls back to its bundled browser, and when that is absent
 * it prints a banner telling you to run `npx playwright install`. In a sandbox with no route to the
 * download CDN that command cannot succeed — and it *prunes* the shared browser cache on its way to
 * failing, so following the advice breaks every other harness on the machine. A minute of seeding,
 * listening and serving happens before the launch, so this belongs at the very top.
 */
export async function requireBrowser() {
  const path = process.env.CHROME_PATH;
  const hint = "set CHROME_PATH to a Chromium binary (and LD_LIBRARY_PATH if it needs one). " +
    "Do not run `npx playwright install`: it cannot reach the CDN here and it empties the shared cache first.";
  if (!path) throw new Error(`CHROME_PATH is not set — ${hint}`);
  try {
    await access(path);
  } catch {
    throw new Error(`CHROME_PATH points at ${path}, which does not exist — ${hint}`);
  }
  return path;
}

/**
 * The page's own text, flattened and clipped.
 *
 * A timed-out locator reports "Timeout 30000ms exceeded" and nothing about whether the app was
 * connected, on another screen, or sitting on an error — and those want different fixes.
 */
export async function visibleText(page) {
  const text = await page.locator("body").innerText().catch((e) => `<unreadable: ${e.message}>`);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    p.on("error", reject);
  });
}

/** Start the server and wait for the address it prints, which is the only way in (22.1). */
function startServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    /*
     * 27.25 — the flags the shipped `serve` task uses, not `-A`.
     *
     * The journey is what proves the permission set is enough: 164 checks driving every path the
     * server has, including the ones that write a PDF and read an audio file back. A harness
     * running with more than the product does would pass on permissions the product lacks.
     *
     * `--allow-read`/`--allow-write` name `./data`, and this runs against a directory under
     * `.tmp`, so the harness adds its own. That is the same adjustment anybody passing `--data`
     * has to make, which is the honest cost of a scoped permission and is what 27.26 is about.
     */
    const p = spawn("deno", [
      "run",
      ...serverFlags().map((flag) =>
        flag.startsWith("--allow-read=") || flag.startsWith("--allow-write=")
          ? `${flag},${dataDir}`
          : flag
      ),
      "server/main.ts",
      "--port",
      String(port),
      "--data",
      dataDir,
    ], { cwd: root });

    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error("the server never printed an address")),
      60_000,
    );
    p.stdout.on("data", (chunk) => {
      buffered += chunk.toString();
      const match = /(\d+\.\d+\.\d+\.\d+:\d+:uEi[A-Za-z0-9_-]+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve({ process: p, address: match[1] });
      }
    });
    p.stderr.on("data", (c) => process.stderr.write(c));
    p.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited ${code} before printing an address`));
    });
  });
}

/**
 * Everything standing up, ready for a browser to arrive.
 *
 * Returns a `rig` with `open()` for a device and `close()` for the lot. Ports are parameters
 * because two of these must be able to run at once without one silently connecting to the other's
 * listener and reporting a green run against the wrong database.
 */
export async function startRig({ dataDir, port, httpPort, seed = true, seedEnv = {} }) {
  const executablePath = await requireBrowser();
  await rm(dataDir, { recursive: true, force: true });

  if (seed) {
    console.log("seeding…");
    // Seeded in the timezone the browser runs in, or the fixture's nine-to-fives render as night
    // shifts -- the entry timings are instants, and only the *dates* are zone-free.
    // 27.25 — what the shipped `seed` task uses, with this run's directory in place of ./data.
    await run("deno", [
      "run",
      "--node-modules-dir=manual",
      `--allow-read=${dataDir}`,
      `--allow-write=${dataDir}`,
      "--allow-env=WORKLOG_SEED_PROMPT_MS",
      "tools/seed.ts",
      dataDir,
    ], {
      env: { ...process.env, TZ: "Australia/Sydney", ...seedEnv },
    });
  } else {
    await mkdir(dataDir, { recursive: true });
  }

  console.log("starting the server…");
  let server = await startServer(dataDir, port);
  console.log(`  ${server.address}`);

  /**
   * Stop the server and start it again on the same port and the same data.
   *
   * The address survives, and that is a property worth leaning on rather than assuming: the KPS
   * certificate lives at `kps-cert.pem` inside the data directory, so the certhash a device stored
   * is still the certhash of the server that comes back. If it were regenerated, every restart
   * would silently invalidate every device's saved address.
   */
  const stopServer = async () => {
    const gone = new Promise((r) => server.process.once("exit", r));
    server.process.kill("SIGTERM");
    await gone;
  };

  const startServerAgain = async () => {
    server = await startServer(dataDir, port);
    return server.address;
  };

  const http = createServer(async (req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    try {
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => http.listen(httpPort, "127.0.0.1", r));

  const browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // A synthetic microphone, and no permission dialog in front of it. 5.23's voice notes are
      // otherwise unreachable from a headless browser: `getUserMedia` either prompts, with nobody
      // to answer, or rejects — and either way the path from MediaRecorder through base64 to the
      // file the server writes has never once been run.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });

  /** Page errors are collected rather than thrown: a run should report all of them, not the first. */
  const errors = [];
  const contexts = [];

  /**
   * A context is a device.
   *
   * That is not incidental -- the device key lives in IndexedDB, so a fresh context has a fresh key
   * and is a genuinely new device as far as the server is concerned. The first attempt at this
   * opened a *third* context to play the admin and hung forever waiting for that one to be
   * approved; the desktop page stays open instead, and does the approving.
   */
  const open = async (label, viewport, deviceName, opts = {}) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: viewport.isMobile ?? false,
      hasTouch: viewport.isMobile ?? false,
      // Pinned so a run does not depend on the machine's preference, and overridable because the
      // dark palette is half the CSS and went two months without anybody looking at it.
      colorScheme: opts.colorScheme ?? "light",
      // Fixed, so a run in Sydney and a run in CI see the same clock and the same dates.
      timezoneId: "Australia/Sydney",
      locale: "en-AU",
      // Granted here as well as at the command line: the fake-UI flag answers the dialog, and this
      // is what stops Playwright's own permission state from refusing before the dialog appears.
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => {
      console.error(`  [${label}] page error: ${e.message}`);
      errors.push(`${label}: ${e.message}`);
    });
    // An unhandled *rejection* is not a `pageerror`, and every failed request in this app is a
    // rejected promise. A run could report "0 page errors" while every write was failing.
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() !== "error" || !/unhandled|rejection/i.test(text)) return;
      console.error(`  [${label}] unhandled rejection: ${text}`);
      errors.push(`${label}: ${text}`);
    });
    // 22.3, 22.4 -- the address is device-local storage, so that is where the harness puts it.
    // There is no URL to put it in, which is the point of 22.4.
    // `opts.noAddress` leaves the device genuinely new, which is the only way to reach the setup
    // screen and the typing-the-address path — everything else here starts already pointed at a
    // server, so that path had never been driven.
    // `opts.address` starts the device pointed somewhere else — 27.1's "saved previous server",
    // which is a state no device reaches by being opened normally.
    if (!opts.noAddress) {
      await page.addInitScript(
        ([address, name]) => {
          /*
           * An init script runs in *every* frame, and 26.11 added one that is not a document of
           * ours: the PDF viewer, in an iframe over a blob URL, where `localStorage` is null. This
           * threw there on every open — a page error the harness then reported against the app,
           * for a line the harness itself had injected.
           */
          if (!globalThis.localStorage) return;
          localStorage.setItem("worklog.serverAddress", address);
          localStorage.setItem("worklog.deviceName", name);

          /*
           * 27.56 — how many blob URLs the page is still holding.
           *
           * A blob URL keeps its bytes alive until it is revoked, and a leak of them is invisible:
           * nothing renders wrong, nothing errors, the tab just grows for as long as it is open.
           * Wrapping the two calls is the only way to see it from outside, and it delegates, so
           * the app behaves exactly as it would have.
           */
          const live = new Set();
          globalThis.__liveBlobs = live;
          const make = URL.createObjectURL.bind(URL);
          const drop = URL.revokeObjectURL.bind(URL);
          URL.createObjectURL = (obj) => {
            const url = make(obj);
            live.add(url);
            return url;
          };
          URL.revokeObjectURL = (url) => {
            live.delete(url);
            drop(url);
          };
        },
        [opts.address ?? server.address, deviceName],
      );
    }
    // `opts.hash` is 27.23's invitation: the page is opened at a URL carrying the server address
    // in its fragment, which with `noAddress` is the only thing that can get this device connected.
    await page.goto(`http://127.0.0.1:${httpPort}/${opts.hash ?? ""}`);
    contexts.push(context);
    return { context, page, label };
  };

  /**
   * Kill the server even when nothing calls `close()`.
   *
   * `close()` used to be reachable only along the happy path, so every harness run that threw —
   * a timed-out locator, a failed check — left its `deno run server/main.ts` alive holding the
   * port. Fourteen of them had accumulated over one day. The next run then dialled a *previous*
   * run's server, against a previous run's database, and failed for reasons that had nothing to do
   * with the code under test: the failure I spent twenty minutes on was a zombie whose clock I had
   * frozen in an experiment I had already reverted.
   *
   * `exit` fires for a normal end and for `process.exit`; the signal handlers cover a `^C` or a
   * timeout from the shell. `SIGKILL` on the child because it is a Deno process with its own
   * signal handling and this is the last thing this process will ever do.
   */
  let reaped = false;
  const reap = () => {
    if (reaped) return;
    reaped = true;
    try {
      server.process.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  process.on("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      reap();
      process.exit(1);
    });
  }

  const close = async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close();
    http.close();
    reap();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { server, stopServer, startServerAgain, open, close, errors, dataDir };
}

/**
 * The first device claims admin; a second asks and is approved from the first.
 *
 * Both tools need an authorized pair before they can do anything, and getting it wrong is the kind
 * of thing that hangs rather than fails (13.6–13.9, 13.11–13.13, 13.27, 13.28).
 */
export async function claimAndApprove(
  rig,
  { onClaimScreen, onRequestScreen, onAccessScreen } = {},
) {
  const desktop = await rig.open("desktop", DESKTOP, "Studio Desktop");
  const claim = desktop.page.getByRole("button", { name: "Claim admin" });
  await claim.waitFor({ timeout: 30_000 });
  await onClaimScreen?.(desktop.page);
  await claim.click();
  await desktop.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });

  const mobile = await rig.open("mobile", MOBILE, "Pixel Phone");
  // 25.31 — one dropdown and one button, rather than a button per role.
  const ask = mobile.page.getByRole("button", { name: "Ask for access" });
  await ask.waitFor({ timeout: 30_000 });
  await onRequestScreen?.(mobile.page);
  await mobile.page.getByLabel("Access needed").selectOption("write");
  await ask.click();
  await mobile.page.getByText("Waiting for approval").waitFor({ timeout: 15_000 });

  console.log("  approving the phone from the desktop…");
  await desktop.page.getByRole("button", { name: "Users", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  // 25.32 — approve grants the role that was asked for; there is no button per role any more.
  await desktop.page.getByRole("row", { name: /Pixel Phone/ })
    .getByRole("button", { name: /^Approve as/ })
    .click();
  await desktop.page.waitForTimeout(600);
  await onAccessScreen?.(desktop.page);

  // 25.33 — no reload. The waiting page notices and offers a way in, which is what it had been
  // promising all along while quietly requiring an F5 that nothing mentioned.
  await mobile.page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 30_000 });
  await mobile.page.getByRole("button", { name: "Continue" }).click();
  await mobile.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });

  return { desktop, mobile };
}
