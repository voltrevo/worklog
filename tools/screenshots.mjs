/**
 * 23.5 — screenshots of both presentations, from a real browser against a real server.
 *
 *     node tools/screenshots.mjs
 *
 * Nothing is mocked. It seeds a database with invented data, starts the actual KPS listener, serves
 * the actual production bundle, and drives Chromium through the actual claim-admin handshake over
 * WebRTC. That makes this the end-to-end test as much as it is a screenshot tool: if the transport,
 * the protocol, the signing or the shells are broken, there are no pictures.
 *
 * `CHROME_PATH` points at a browser, because Playwright cannot download one in every environment.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "web/dist");
const outDir = join(root, "docs");
const dataDir = join(root, ".screenshots-data");
const PORT = 41777;
const HTTP_PORT = 5399;

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 };

const SCREENS = ["timer", "history", "pacing", "invoices", "admin", "settings"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    p.on("error", reject);
  });
}

/** Start the server and wait for the address it prints, which is the only way in (22.1). */
function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("deno", [
      "run",
      "-A",
      "--node-modules-dir=manual",
      "server/main.ts",
      "--port",
      String(PORT),
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

async function main() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log("seeding…");
  // Seeded in the timezone the screenshots are taken in, or the fixture's nine-to-fives render as
  // night shifts -- the entry timings are instants, and only the *dates* are zone-free.
  await run("deno", ["run", "-A", "--node-modules-dir=manual", "tools/seed.ts", dataDir], {
    env: { ...process.env, TZ: "Australia/Sydney" },
  });

  console.log("starting the server…");
  const server = await startServer();
  console.log(`  ${server.address}`);

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
  await new Promise((r) => http.listen(HTTP_PORT, "127.0.0.1", r));

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  let failures = 0;
  const watch = (page, label) =>
    page.on("pageerror", (e) => {
      console.error(`  [${label}] page error: ${e.message}`);
      failures++;
    });

  /**
   * A context is a device.
   *
   * That is not incidental -- the device key lives in IndexedDB, so a fresh context has a fresh key
   * and is a genuinely new device as far as the server is concerned. The first attempt at this
   * harness opened a *third* context to play the admin and hung forever waiting for that one to be
   * approved. The desktop page stays open instead, and does the approving.
   */
  const open = async (label, viewport, deviceName) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: viewport.isMobile ?? false,
      hasTouch: viewport.isMobile ?? false,
      colorScheme: "light",
      // Fixed, so a screenshot taken in Sydney and one taken in CI look the same.
      timezoneId: "Australia/Sydney",
      locale: "en-AU",
    });
    const page = await context.newPage();
    watch(page, label);
    // 22.3, 22.4 -- the address is device-local storage, so that is where the harness puts it.
    // There is no URL to put it in, which is the point of 22.4.
    await page.addInitScript(
      ([address, name]) => {
        localStorage.setItem("worklog.serverAddress", address);
        localStorage.setItem("worklog.deviceName", name);
      },
      [server.address, deviceName],
    );
    await page.goto(`http://127.0.0.1:${HTTP_PORT}/`);
    return { context, page };
  };

  // ---- the first device claims admin (13.6-13.9)
  const desktop = await open("desktop", DESKTOP, "Studio Desktop");
  const claim = desktop.page.getByRole("button", { name: "Claim admin" });
  await claim.waitFor({ timeout: 30_000 });
  await shot(desktop.page, outDir, "claim-desktop");
  await claim.click();
  await desktop.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });
  await capture(desktop.page, "desktop");

  // ---- the second is a new device, so it asks and the first approves (13.11-13.13, 13.27, 13.28)
  const mobile = await open("mobile", MOBILE, "Pixel Phone");
  const ask = mobile.page.getByRole("button", { name: "Ask for write access" });
  await ask.waitFor({ timeout: 30_000 });
  await shot(mobile.page, outDir, "request-mobile");
  await ask.click();
  await mobile.page.getByText("Waiting for approval").waitFor({ timeout: 15_000 });

  console.log("  approving the phone from the desktop...");
  await desktop.page.getByRole("button", { name: "Admin", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  await desktop.page.getByRole("row", { name: /Pixel Phone/ })
    .getByRole("button", { name: "write", exact: true })
    .click();
  await desktop.page.waitForTimeout(600);
  await shot(desktop.page, outDir, "access-desktop");

  await mobile.page.reload();
  await mobile.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });
  await capture(mobile.page, "mobile");

  await mobile.context.close();
  await desktop.context.close();

  await browser.close();
  http.close();
  server.process.kill();
  await rm(dataDir, { recursive: true, force: true });

  console.log(
    failures === 0 ? "\nall screens captured, no page errors" : `\n${failures} page errors`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function capture(page, label) {
  for (const screen of SCREENS) {
    const nav = page.getByRole("button", { name: navLabel(screen), exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
      console.log(`  [${label}] ${screen} is not in this shell's navigation, skipping`);
      continue;
    }
    await nav.click();
    await page.waitForTimeout(400);
    await shot(page, outDir, `${screen}-${label}`);
  }
}

function navLabel(screen) {
  return screen.charAt(0).toUpperCase() + screen.slice(1);
}

async function shot(page, dir, name) {
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${name}.png`);
}

await main().catch((err) => {
  console.error(`screenshots: ${err.message}`);
  process.exit(1);
});
