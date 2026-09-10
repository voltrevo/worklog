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

Deno.test({
  name: "25.1 -- a list's state starts undefined, not empty",
  permissions: { read: ["."], run: ["git"] },
  async fn() {
    /*
     * "We have not asked yet" and "there is nothing" are different facts, and `useState<T[]>([])`
     * cannot tell them apart. Three lists in this app said the second when they meant the first:
     * the notes screen greeted a slow connection with "Nothing noted yet.", and the admin screen
     * — testing `pending?.length === 0`, which is false while `pending` is undefined — fell
     * through to `(pending ?? []).map` and drew a card with no words in it at all.
     *
     * A guard rather than a test of any one screen, because the fault is a habit. It reappears
     * every time somebody adds a list and reaches for the initialiser that avoids a null check,
     * and it is invisible on a fast connection, which every connection is while you are building.
     *
     * **The type alone is not the signal, and the first version of this guard was wrong about
     * that.** It flagged every `useState<T[]>([])` and found three, all of them correct: a list of
     * unreadable field names, a waveform's rolling samples, and a sentence in a comment describing
     * the bug. For a value this component accumulates itself, `[]` is the truth — nothing has
     * happened yet.
     *
     * What makes `[]` a lie is the list being *answered by the server*. So the setter has to be
     * one that a response is handed to: `setX(await …)` or `.then(setX)`. That is the case where
     * "empty" is a claim about somebody's data rather than about a buffer.
     */
    const root = new URL("..", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of (await trackedFiles()).filter((f) => f.endsWith(".tsx"))) {
      const text = await Deno.readTextFile(`${root}${file}`);
      for (const [i, line] of text.split("\n").entries()) {
        // Not a comment. The description of this very fault lives in `Listing.tsx` and matched.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        const declared = /useState<[^>]*\[\]>\(\[\]\)/.exec(line);
        if (!declared) continue;
        const setter = /const \[[^,]+,\s*(set\w+)\s*\]/.exec(line)?.[1];
        if (!setter) continue;
        const filled = new RegExp(`${setter}\\s*\\(\\s*await\\b|\\.then\\(\\s*${setter}\\s*\\)`);
        if (filled.test(text)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      }
    }
    assertEquals(
      offenders,
      [],
      "a list initialised to [] renders 'nothing here' before it has asked (25.1)",
    );
  },
});

Deno.test({
  name: "every requirement has its own number, and no section skips one",
  permissions: { read: ["."] },
  async fn() {
    /*
     * The document is append-only within each list, and three review passes have appended to it.
     * Adding an item means reading off the last number in a section — and the last number in
     * *section 6* is not the one nearest the bottom of section 6, because 6.37 is struck through
     * and 6.38 came later. I wrote a second 6.38 that way this afternoon and caught it by eye.
     *
     * Two properties, and the second is the one that finds a typo: numbers are unique, and each
     * section runs 1..N with nothing missing. A gap means somebody skipped, and a skip is usually
     * a mistyped number that is now also a duplicate somewhere else.
     */
    const root = new URL("..", import.meta.url).pathname;
    const text = await Deno.readTextFile(`${root}REQUIREMENTS.md`);
    const numbers = [...text.matchAll(/^(\d+)\.(\d+)\.\s/gm)]
      .map(([, section, item]) => ({ section: Number(section), item: Number(item) }));

    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const { section, item } of numbers) {
      const key = `${section}.${item}`;
      if (seen.has(key)) duplicated.push(key);
      seen.add(key);
    }
    assertEquals(duplicated, [], "a requirement number is used twice");

    const gaps: string[] = [];
    const bySection = new Map<number, Set<number>>();
    for (const { section, item } of numbers) {
      if (!bySection.has(section)) bySection.set(section, new Set());
      bySection.get(section)!.add(item);
    }
    for (const [section, items] of [...bySection].sort((a, b) => a[0] - b[0])) {
      const highest = Math.max(...items);
      for (let i = 1; i <= highest; i++) {
        if (!items.has(i)) gaps.push(`${section}.${i}`);
      }
    }
    assertEquals(gaps, [], "a section skips a number, which is usually a mistyped one");

    // And the count, so that a regex which stops matching reads as a fault rather than a pass.
    assertEquals(numbers.length > 500, true, `only found ${numbers.length} requirements`);
  },
});

Deno.test({
  name: "27.25 -- no task runs with -A",
  permissions: { read: ["."] },
  async fn() {
    /*
     * The easy thing to type, and the thing this whole requirement is against. It is also the easy
     * thing to *reach for* when a task fails on a permission: the fix is to name the permission,
     * and `-A` is always right there making that unnecessary.
     *
     * A guard rather than a review note, because a task string is read once when it is written and
     * never again, and nothing else in the suite would notice.
     */
    const config = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
    const offenders = Object.entries(config.tasks as Record<string, string>)
      .filter(([name]) => !name.startsWith("//"))
      .filter(([, cmd]) => / -A\b/.test(cmd) || cmd.includes("--allow-all"))
      .map(([name]) => name);
    assertEquals(offenders, [], "a task grants every permission (27.25)");
  },
});

Deno.test({
  name: "27.25 -- the serve task is the shape the harness reads its flags from",
  permissions: { read: ["."] },
  async fn() {
    /*
     * `tools/serverFlags.mjs` lifts the permission flags out of the `serve` task so the journey
     * runs the server the way the product does. It throws on an unexpected shape, but only when
     * something runs it — and the thing that runs it is a five-minute browser suite, which is a
     * long way to go to be told a task was reworded.
     */
    const config = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
    const found = /^deno run (.+) server\/main\.ts$/.exec(config.tasks.serve);
    assertEquals(
      found !== null,
      true,
      `the serve task must be "deno run <flags> server/main.ts", and is: ${config.tasks.serve}`,
    );
    // And the flags are the ones 27.25 argues for, so a quiet widening is a red test rather than a
    // diff nobody reads.
    assertEquals((found?.[1] ?? "").split(" ").filter((f) => f.startsWith("--allow-")).sort(), [
      "--allow-ffi=./node_modules",
      "--allow-net",
      "--allow-read=./data,./node_modules",
      "--allow-sys=networkInterfaces",
      "--allow-write=./data",
    ]);
  },
});
