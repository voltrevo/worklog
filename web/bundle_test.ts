/**
 * What the public bundle is allowed to contain (20.6, 22.5).
 *
 * `web/dist` is deployed to GitHub Pages on every push to `main`, so anything in it is published.
 * 22.5 says it must not carry a server address, and the reason is not tidiness: the address *is*
 * the credential. `<ip>:<port>:<certhash>` is the whole of what a stranger needs to reach the
 * server and start asking for access, which is why the README calls it a secret and why 13.41
 * treats it as the bootstrap secret in place of a separate code.
 *
 * Nothing checked this. It happened to be true, and it happened to be true because
 * `saveAddress`/`loadAddress` keep the address in device storage (22.3) and no build step ever
 * touches it — but "no code puts it there" is an argument, and this is a check.
 *
 * **The discriminator is the certhash's length.** The connect screen shows an example address so a
 * person knows what to paste, so a guard that merely looks for `<ip>:<port>:` is a guard that fires
 * on the placeholder and gets deleted by whoever it wakes up at the wrong moment. A real certhash
 * is a multibase-encoded digest — forty-odd base64url characters after `uEi`. The placeholder is
 * `uEiA…`, four characters and an ellipsis, and it cannot be lengthened into a real one by
 * accident. So: complete certhashes are forbidden, illustrative fragments are not.
 *
 * Run by `deno task test:bundle`, which the gate places **after** `web:build` — not by `deno task
 * test`, which runs before it. That ordering is the whole point: a bundle guard that runs first
 * checks whichever build happened to be lying around, and on a fresh clone finds nothing at all
 * and skips in silence. The `present()` guard below is a fallback for someone running this file by
 * hand, not the expected path.
 */

import { assertEquals } from "jsr:@std/assert@^1";

const DIST = new URL("./dist/", import.meta.url).pathname;

/**
 * `uEi` and forty more base64url characters. A truncated example cannot reach this length; a real
 * SHA-256 multihash cannot fall short of it.
 */
const COMPLETE_CERTHASH = /uEi[A-Za-z0-9_-]{40,}/g;

/** Anything that has been used as fixture data anywhere, in case a bundler ever inlines a seed. */
const FIXTURE_STRINGS = [
  "Bank of Nowhere",
  "Studio Desktop",
  "Pixel Phone",
  "Spare Tablet",
  "000-000",
];

async function bundleFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory) await walk(`${path}/`, `${prefix}${entry.name}/`);
      else if (/\.(js|html|css|map)$/.test(entry.name)) {
        out.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(DIST, "");
  return out.sort();
}

const READS_DIST: Pick<Deno.TestDefinition, "permissions"> = {
  permissions: { read: ["./web/dist"] },
};

async function present(): Promise<boolean> {
  try {
    await Deno.stat(DIST);
    return true;
  } catch {
    console.log("  (web/dist not built; run `deno task web:build`)");
    return false;
  }
}

Deno.test({
  name: "22.5 -- the published bundle carries no server address",
  ...READS_DIST,
  async fn() {
    if (!await present()) return;
    const files = await bundleFiles();
    assertEquals(
      files.length > 0,
      true,
      "a bundle with no files is not a bundle",
    );

    const found: string[] = [];
    for (const file of files) {
      const text = await Deno.readTextFile(`${DIST}${file}`);
      for (const hit of text.match(COMPLETE_CERTHASH) ?? []) {
        found.push(`${file}: ${hit.slice(0, 24)}…`);
      }
    }
    assertEquals(
      found,
      [],
      "a complete certhash in the Pages bundle publishes the way into somebody's server",
    );
  },
});

Deno.test({
  name: "and the guard can tell a real address from the one on the connect screen",
  ...READS_DIST,
  fn() {
    // Both halves matter. A guard that misses the real thing is useless; a guard that fires on the
    // example is one somebody switches off, and then it misses the real thing too.
    //
    // The "real" address below is a *shaped* string, not a real one. The first version of this
    // test pasted a certhash straight out of a live server's startup line, which committed a
    // genuine server identity to a repository whose whole point is that the identity is the way
    // in. It was ephemeral — the harness deletes its cert on exit — but nothing about reading the
    // file said so, and the next person to need a realistic fixture would have copied the method.
    const real = "192.168.1.5:41108:uEiSECONDexampleSECONDexampleSECONDexampleSECO";
    const shown = "192.168.1.5:41108:uEiA…";
    assertEquals(
      COMPLETE_CERTHASH.test(real),
      true,
      "must catch a real address",
    );
    COMPLETE_CERTHASH.lastIndex = 0; // `g` makes `test` stateful, which is its own small trap.
    assertEquals(
      COMPLETE_CERTHASH.test(shown),
      false,
      "must not catch the placeholder",
    );
    COMPLETE_CERTHASH.lastIndex = 0;
  },
});

Deno.test({
  name: "20.6 -- and no fixture data either",
  ...READS_DIST,
  async fn() {
    if (!await present()) return;
    const found: string[] = [];
    for (const file of await bundleFiles()) {
      const text = await Deno.readTextFile(`${DIST}${file}`);
      for (const s of FIXTURE_STRINGS) {
        if (text.includes(s)) found.push(`${file}: ${s}`);
      }
    }
    assertEquals(found, [], "seed data reached the published bundle");
  },
});

Deno.test({
  name: "27.24 -- the published site carries what a phone needs to install it",
  ...READS_DIST,
  async fn() {
    if (!await present()) return;
    const manifest = JSON.parse(await Deno.readTextFile(`${DIST}manifest.webmanifest`));

    /*
     * Relative, and it has to be. The site is served from a GitHub Pages subpath
     * (`/<repo>/`), and an absolute `start_url: "/"` sends an installed app to the root of
     * github.io — someone else's page. `scope` the same, or the installed window opens every
     * in-app link in a browser tab instead.
     */
    assertEquals(manifest.start_url, "./");
    assertEquals(manifest.scope, "./");
    assertEquals(manifest.display, "standalone");

    // Chrome's installability floor: an icon of at least 192 and one of at least 512, and a
    // maskable one so Android does not letterbox it inside a white circle.
    const sizes = (manifest.icons as { sizes: string; purpose: string }[]).map((i) => i.sizes);
    assertEquals(sizes.includes("192x192"), true, "no 192 icon");
    assertEquals(sizes.includes("512x512"), true, "no 512 icon");
    assertEquals(
      (manifest.icons as { purpose: string }[]).some((i) => i.purpose === "maskable"),
      true,
      "no maskable icon",
    );

    // Every file the manifest names is actually shipped. A manifest naming an icon that 404s is
    // not installable and reports nothing about why.
    for (const icon of manifest.icons as { src: string }[]) {
      await Deno.stat(`${DIST}${icon.src.replace(/^\.\//, "")}`);
    }
    await Deno.stat(`${DIST}sw.js`);

    const html = await Deno.readTextFile(`${DIST}index.html`);
    assertEquals(html.includes('rel="manifest"'), true, "index.html does not link the manifest");

    /*
     * And the desktop page does not. It is loaded from `file://` as one self-contained document,
     * so a manifest link and three icon links are four requests that cannot succeed — and there is
     * nothing to install there, it being an installed application already.
     */
    const desktop = await Deno.readTextFile(`${DIST}desktop.html`);
    assertEquals(
      /<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"/.test(desktop),
      false,
      "desktop.html still links install metadata it cannot fetch",
    );
  },
});

Deno.test({
  name: "27.24 -- and the service worker stays a pass-through",
  ...READS_DIST,
  async fn() {
    if (!await present()) return;
    const sw = await Deno.readTextFile(`${DIST}sw.js`);
    /*
     * A guard rather than a test, because the failure is silent and slow: the obvious improvement
     * to a do-nothing worker is a cache, and a cached bundle outlives a deploy on a device that
     * never happens to look. Nothing this app fetches is stale-tolerant.
     */
    assertEquals(
      /caches\s*[.[]|CacheStorage|cache\.match/.test(sw),
      false,
      "the service worker has grown a cache (27.24 says it must not)",
    );
  },
});
