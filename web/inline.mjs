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
    html = html.replace(match[0], wrap(body));
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
  (js) => `<script type="module">\n${js.replace(/\/\/# sourceMappingURL=.*$/m, "")}\n</script>`,
);

const out = join(dist, "desktop.html");
await writeFile(out, html);
console.log(
  `desktop.html: ${styles} stylesheet(s) and ${scripts} script(s) inlined, ` +
    `${(html.length / 1024).toFixed(0)} kB`,
);
