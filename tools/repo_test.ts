/**
 * Nothing enormous, and nothing built, is tracked in git.
 *
 * This exists because it already happened. `desktop:check` used to build into `.desktop-selftest/`;
 * renaming its output to `worklog-check/` moved the `.gitignore` line with it, the old directory
 * was still on disk from earlier runs, and the next `git add -A` committed a **192 MB** compiled
 * webview app. The next commit deleted it, which takes it out of the tree and leaves it in history
 * forever — the bare repo grew from a few megabytes to 74, and a GitHub mirror would now be
 * rejected outright, because their limit is 100 MB per file measured uncompressed.
 *
 * The rule was not missing. A stale directory outlived it, which is a thing a `.gitignore` cannot
 * notice and a size check can.
 *
 * The threshold is deliberately far below anything legitimate here: the largest thing this repo
 * should ever track is a screenshot, and those are under 200 kB.
 */

import { assertEquals } from "jsr:@std/assert@^1";

/** Generous. A PDF fixture or a large diagram would pass; a compiled binary would not. */
const MAX_BYTES = 2 * 1024 * 1024;

const READS_REPO: Pick<Deno.TestDefinition, "permissions"> = {
  permissions: { read: ["."], run: ["git"] },
};

async function trackedFiles(): Promise<string[]> {
  const git = new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    /**
     * Nothing inherited.
     *
     * Deno refuses to spawn with `LD_LIBRARY_PATH` in the environment unless granted blanket
     * `--allow-run`, and it is right to: that variable can make a child load anything. The browser
     * harnesses set it, so a suite run in a shell that had sourced their env failed here and
     * nowhere else — passing on its own, failing after `deno task shots`, which is the most
     * annoying shape a failure comes in.
     *
     * `git ls-files` needs no environment at all: Deno resolves the program in this process, and
     * the repository is found from `cwd`.
     */
    clearEnv: true,
  });
  const { success, stdout } = await git.output();
  if (!success) throw new Error("git ls-files failed");
  return new TextDecoder().decode(stdout).split("\0").filter((f) => f.length > 0);
}

Deno.test({
  name: "no tracked file is large enough to be a build artefact",
  ...READS_REPO,
  async fn() {
    const root = new URL("..", import.meta.url).pathname;
    const oversized: string[] = [];
    for (const file of await trackedFiles()) {
      const stat = await Deno.stat(`${root}${file}`).catch(() => undefined);
      if (stat && stat.size > MAX_BYTES) {
        oversized.push(`${file} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
    assertEquals(
      oversized,
      [],
      "committing this is not undoable: deleting it later leaves it in history and in every clone",
    );
  },
});

Deno.test({
  name: "and no build output directory is tracked",
  ...READS_REPO,
  async fn() {
    // By prefix rather than by size, because these arrive small and grow, and because the point is
    // that they should not be here at all. Every one of them is a `deno task` output.
    const BUILT = [
      "web/dist/",
      "worklog-dev/",
      "worklog-check/",
      "Worklog/",
      "Worklog.app/",
      ".desktop-selftest/",
      "node_modules/",
      ".screenshots-data/",
      ".journey-data/",
    ];
    const tracked = await trackedFiles();
    const leaked = tracked.filter((f) => BUILT.some((p) => f.startsWith(p)));
    assertEquals(leaked, [], "a build output is tracked; check .gitignore against the task names");
  },
});

Deno.test({
  name: "every local file the sources import is itself tracked",
  ...READS_REPO,
  async fn() {
    /*
     * The repository has to build from a clean clone, and for a long time it did not.
     *
     * `.gitignore` carried an unanchored `data/` to keep the server's runtime directory out. It
     * also matched `server/data/`, which holds the holiday snapshot `holidays.ts` *imports* — so
     * the file existed on my machine, untracked, and every check passed. A fresh clone could not
     * type-check, let alone run. Nothing noticed because nothing had ever started from a clone.
     *
     * The size guards above catch a build output that got *in*. This catches a required input that
     * stayed *out*, which is the failure that hides, because the person who introduced it is the
     * one person who cannot reproduce it.
     */
    const root = new URL("..", import.meta.url).pathname;
    const tracked = new Set(await trackedFiles());
    const sources = [...tracked].filter((f) => /\.(ts|tsx|mjs)$/.test(f));

    const missing: string[] = [];
    for (const file of sources) {
      const text = await Deno.readTextFile(`${root}${file}`);
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
      // Relative specifiers only: bare ones are npm or jsr and are the lockfile's problem.
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        const spec = match[1]!;
        const resolved = new URL(spec, `file:///${dir}`).pathname.replace(/^\//, "");
        if (!tracked.has(resolved)) missing.push(`${file} imports ${spec} (${resolved})`);
      }
    }
    assertEquals(missing, [], "an import resolves to a file no clone would have");
  },
});
