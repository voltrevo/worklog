/**
 * The built site, served the way GitHub Pages serves it (27.50).
 *
 * Everything else that loads this frontend serves `web/dist` from the root of a host: the journey's
 * static server, `deno task web`, the desktop shell's `file://` page. Pages does not — it serves it
 * from `/<repo>/`, and that is the copy strangers use, deployed on every push to `main`.
 *
 * What only breaks there: an absolute `base` in the vite config, an absolute `href` on the
 * manifest or the icons, a `start_url` of `/`, and a service worker registered from a path that
 * scopes it to the whole origin. None of those fail a build, and none of them fail when the same
 * files are served from `/`. CI is green either way, which is the reason to have this.
 *
 *     deno task pages
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { requireBrowser, root } from "./harness.mjs";

/** A stand-in for `github.io/<repo>/`. Any non-root prefix would do; this is the real one. */
const BASE = "/worklog/";
const PORT = 5501;

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

const dist = join(root, "web", "dist");
const failures = [];
const outside = [];
const notFound = [];

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith(BASE)) {
    // The interesting failure: something asked for an absolute path, which on Pages is somebody
    // else's site. `/favicon.ico` is the browser guessing and is not the app's doing.
    if (url !== "/favicon.ico") outside.push(url);
    res.writeHead(404).end("not this site");
    return;
  }
  const asked = url.slice(BASE.length).split("?")[0];
  const rel = !asked || asked === "/" ? "index.html" : normalize(asked);
  try {
    const body = await readFile(join(dist, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    notFound.push(url);
    res.writeHead(404).end("not found");
  }
});

const executablePath = await requireBrowser();
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

console.log(`serving web/dist at http://127.0.0.1:${PORT}${BASE}\n`);
await page.goto(`http://127.0.0.1:${PORT}${BASE}`, { waitUntil: "networkidle" });
// The connect screen is the first thing a stranger sees, and it is React having rendered.
await page.waitForTimeout(1_500);

check(
  "the app mounts when it is not at the root of a host",
  (await page.evaluate(() => document.querySelector("#root")?.children.length ?? 0)) > 0,
  await page.evaluate(() => document.body.innerText.slice(0, 120)),
);

const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel="manifest"]')?.href;
  if (!href) return { ok: false, why: "no manifest link" };
  const res = await fetch(href);
  if (!res.ok) return { ok: false, why: `manifest ${res.status} at ${href}` };
  const body = await res.json();
  const icons = await Promise.all(
    body.icons.map(async (i) => (await fetch(new URL(i.src, href))).ok),
  );
  return { ok: true, startUrl: body.start_url, scope: body.scope, icons: icons.every(Boolean) };
});
check("its manifest is reachable from the subpath", manifest.ok, manifest.why ?? "");
check("and every icon the manifest names is too", manifest.icons === true);
check(
  "and start_url and scope are relative, so an installed app opens this site",
  manifest.startUrl === "./" && manifest.scope === "./",
  `${manifest.startUrl} / ${manifest.scope}`,
);

const scope = await page.evaluate(() =>
  navigator.serviceWorker.getRegistration().then((r) => r?.scope ?? "none")
);
check(
  "the service worker scopes to this app, not to the whole origin",
  scope === `http://127.0.0.1:${PORT}${BASE}`,
  scope,
);

check("nothing asked for a path outside the subpath", outside.length === 0, outside.join(", "));
check("nothing 404ed", notFound.length === 0, notFound.join(", "));
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();

console.log(
  failures.length === 0
    ? "\nthe Pages copy works where it is actually served"
    : `\n${failures.length} failed: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
