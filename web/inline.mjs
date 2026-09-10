/**
 * One self-contained HTML file for the desktop window.
 *
 *     node web/inline.mjs        # after `vite build`, writes web/dist/desktop.html
 *
 * **A `file://` page cannot load an ES module by `src`.** Every engine treats a module fetched
 * from a file URL as cross-origin and refuses it, so the desktop window loaded `index.html`,
 * fetched nothing, and sat there blank — the shell was working perfectly and the app never ran.
 * An *inline* module has nothing to fetch, so this folds the bundle and the stylesheet into the
 * document and the same code runs.
 *
 * The GitHub Pages build is untouched: `index.html` still links its assets, which is what a real
 * origin wants for caching. This is an extra artefact beside it, not a different build.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = join(import.meta.dirname, "dist");
let html = await readFile(join(dist, "index.html"), "utf8");

/** Replace each `<link rel=stylesheet>` and `<script src>` with its contents. */
async function inline(pattern, wrap) {
  const matches = [...html.matchAll(pattern)];
  for (const match of matches) {
    const href = match[1];
    if (/^https?:/.test(href)) continue; // nothing remote is inlined; there is nothing remote
    const body = await readFile(join(dist, href.replace(/^\.?\//, "")), "utf8");
    // A *function* replacement, because a string one is scanned for `$&`, `` $` ``, `$'` and `$1`
    // and expands them. A minified React bundle contains `$&`, so the string form spliced fragments
    // of the surrounding document into the middle of the script and produced a `SyntaxError` at
    // load — a blank window, no console, and a shell that reported success. This is the bug that
    // made the desktop app never work.
    html = html.replace(match[0], () => wrap(body));
  }
  return matches.length;
}

const styles = await inline(
  /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g,
  (css) => `<style>\n${css}\n</style>`,
);
const scripts = await inline(
  /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
  // `//# sourceMappingURL` would point at a file the page cannot fetch either, so it goes.
  /**
   * Wrapped in a `try`, because a `file://` module that throws reports `Script error. @ ?:0` and
   * nothing else — the origin is opaque, so the engine sanitises the message, and a window that
   * failed to start is indistinguishable from one that started and rendered nothing. Inside the
   * module the error is not sanitised, so this is the only place the truth is available.
   *
   * Safe because the bundle is fully bundled: no top-level `import` or `export`, which a `try`
   * block would not permit.
   */
  (js) =>
    `<script type="module">\ntry {\n${
      js.replace(/\/\/# sourceMappingURL=.*$/m, "")
    }\n  globalThis.__worklogBoot.module = "ran";\n} catch (e) {\n` +
    `  globalThis.__worklogBoot.module = "threw: " + String((e && e.stack) || e);\n}\n</script>`,
);

/**
 * The one thing that distinguishes this build from the Pages one at runtime (see
 * `web/src/bridge.ts`). It must come before the module, because `isDesktop()` is read during the
 * first render.
 *
 * A flag rather than a probe for an injected global: the shell injects nothing until it has
 * polled, and the previous arrangement — "look for a function the host bound onto window" — was
 * permanently false inside the desktop window and silently chose the browser code path.
 */
const PRELUDE = `<script>
globalThis.__worklogDesktopBuild = true;
// The shell has no console and no devtools, so everything that goes wrong is kept where
// \`executeJs\` can find it. On a \`file://\` origin the engine sanitises script errors to
// "Script error." with no location, so several signals are recorded separately rather than
// collapsed into the first one — the useless one arrives first and would mask the rest.
globalThis.__worklogBoot = { errors: [], rejections: [], module: "" };
addEventListener("error", (e) => {
  globalThis.__worklogBoot.errors.push(
    String(e.message) + " @ " + (e.filename || "?") + ":" + e.lineno +
      ((e.error && e.error.stack) ? " :: " + e.error.stack : "")
  );
});
addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  globalThis.__worklogBoot.rejections.push(String((r && r.stack) || (r && r.message) || r));
});
</script>`;

html = html.replace('<script type="module">', () => `${PRELUDE}\n<script type="module">`);

/*
 * 27.24 — the install metadata comes out again for the desktop window.
 *
 * This document is loaded from `file://` as a single self-contained page: the manifest, the icons
 * and the favicon are separate files that are not shipped beside it, so every one of these links
 * is a request that cannot succeed. There is nothing to install here either — it is already an
 * installed application — so they are removed rather than made to work.
 */
const dropped = [...html.matchAll(/<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"[^>]*>\s*/g)];
for (const link of dropped) html = html.replace(link[0], () => "");

const out = join(dist, "desktop.html");
await writeFile(out, html);
console.log(
  `desktop.html: ${styles} stylesheet(s) and ${scripts} script(s) inlined, ` +
    `${(html.length / 1024).toFixed(0)} kB, ${dropped.length} install link(s) dropped`,
);
