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
