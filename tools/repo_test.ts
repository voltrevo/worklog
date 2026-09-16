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
  name: "no task runs with -A",
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
  name: "the serve task is the shape the harness reads its flags from",
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

Deno.test({
  name: "the requirements document's own bookkeeping holds together",
  permissions: { read: ["."] },
  async fn() {
    /*
     * The document is append-only: a decision that changes is struck through and a new item is
     * added saying so. That convention is the only record of *why* the product does something
     * other than what an earlier line says, and it is maintained by hand.
     *
     * What this catches is the half-done edit — adding "Supersedes 6.3" and forgetting to strike
     * 6.3, or naming an item that does not exist. What it cannot catch is the edit nobody made at
     * all: 6.32 required a default holiday region for months after 24.33 removed it, because
     * nothing claimed to supersede it and nothing was struck. That one needed reading, and is the
     * reason this exists — the mechanical half should at least be free.
     */
    const text = await Deno.readTextFile(new URL("../REQUIREMENTS.md", import.meta.url));
    const items = new Map<string, string>();
    for (const line of text.split("\n")) {
      const found = /^(\d+\.\d+)\.\s+(.*)$/.exec(line);
      if (found) items.set(found[1]!, found[2]!);
    }
    // A sanity floor: a regex that silently matched nothing would make every check below vacuous.
    assertEquals(items.size > 400, true, `only ${items.size} requirements parsed`);

    const struck = new Set([...items].filter(([, t]) => t.includes("~~")).map(([n]) => n));
    const problems: string[] = [];

    for (const [number, body] of items) {
      for (const named of body.matchAll(/[Ss]upersed(?:es|ed by)\s+([\d.,\sand]+)/g)) {
        for (const one of named[1]!.matchAll(/\d+\.\d+/g)) {
          if (!items.has(one[0])) problems.push(`${number} names ${one[0]}, which does not exist`);
        }
      }
      // "X supersedes Y" is a claim about Y as well, and Y has to show it.
      // Both cases and both spellings: the convention is "Supersedes N", and an edit that writes
      // "supersedes" or "superseding" is making the same claim and must meet the same rule.
      for (const one of body.matchAll(/[Ss]upersed(?:es|ing)\s+(\d+\.\d+)/g)) {
        if (items.has(one[1]!) && !struck.has(one[1]!)) {
          problems.push(`${number} supersedes ${one[1]}, which is not struck through`);
        }
      }
      /*
       * And the passive form is a claim about *this* item: saying "Superseded by 27.32" while
       * still standing as a live MUST is the half-done edit in its other direction. Found by
       * mutation — the rules above all passed with 6.23 unstruck and still announcing what had
       * replaced it, which is precisely the state that leaves the product contradicting the spec.
       */
      if (/[Ss]uperseded by\s+\d+\.\d+/.test(body) && !struck.has(number)) {
        problems.push(`${number} says it is superseded and is not struck through`);
      }
    }
    for (const number of struck) {
      // Struck, and silent about why: the next reader has to guess whether it was superseded,
      // declined, or deleted by accident.
      if (!/[Ss]upersed|[Ww]ithdraw|[Rr]eplaced|declined/.test(items.get(number)!)) {
        problems.push(`${number} is struck through and does not say by what`);
      }
    }

    assertEquals(problems, [], "the requirements document contradicts itself");
  },
});

Deno.test({
  name: "no screen works out for itself whether it may write",
  // `trackedFiles` shells out to git, like the other walks over the repo in this file.
  permissions: { read: ["."], run: ["git"] },
  async fn() {
    /*
     * Five screens held their own copy of `phase.role !== "read"`, and all five agreed — which is
     * the state a copied rule is in right up until it is not. This is the rule that decides
     * whether Start, Save, Delete and the invoice editor are offered, so a divergence shows a
     * control that a read-only device cannot actually use.
     *
     * A guard rather than a note, because the copy is the easy thing to write: `phase` is already
     * destructured for other reasons, and the expression is one line.
     */
    const root = new URL("../web/src/", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of (await trackedFiles()).filter((f) => f.startsWith("web/src/"))) {
      if (file.endsWith("state.tsx")) continue; // where the rule lives
      const text = await Deno.readTextFile(`${root}${file.slice("web/src/".length)}`);
      for (const [i, line] of text.split("\n").entries()) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        /*
         * `!== "read"` only, which is the *permission* form. Naming the role is a different act
         * and a legitimate one: the header says "Connected · read-only access" and the Users
         * screen says which key this device holds, both with `=== "read"`, and neither decides
         * whether a control appears.
         */
        if (/role\s*!==\s*"read"/.test(line)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      }
    }
    assertEquals(offenders, [], "a screen decided for itself whether it may write (27.43)");
  },
});

Deno.test({
  name: "a rule or an algorithm lives in one file",
  permissions: { read: ["."], run: ["git"] },
  async fn() {
    /*
     * Found by scanning for identical non-trivial lines across files. Most of what that turns up
     * is idiom — a `<div className="row between wrap">` in seven screens is seven rows, not seven
     * copies of a decision — but three were not:
     *
     * - `toBase64`/`fromBase64`, declared four times. Device private keys, note audio and invoice
     *   PDFs all pass through them, and a divergence corrupts binary data silently.
     * - `MS_PER_HOUR`, three times.
     * - the timed-entry `{ startedAt, endedAt }` shape, five times, across the wire and the
     *   server — the same class of thing as `PublicInvoiceConfig` being declared twice (27.45).
     *
     * This guards the one with teeth. The others are named types and constants now, and the
     * compiler notices if they move.
     */
    const root = new URL("..", import.meta.url).pathname;
    const declared: string[] = [];
    for (
      const file of (await trackedFiles()).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    ) {
      if (file === "shared/protocol.ts") continue; // where they live
      const text = await Deno.readTextFile(`${root}${file}`);
      for (const [i, line] of text.split("\n").entries()) {
        if (/^\s*(function|const|export function)\s+(to|from)Base64\b/.test(line)) {
          declared.push(`${file}:${i + 1}`);
        }
      }
    }
    assertEquals(declared, [], "base64 is declared outside shared/protocol.ts (27.46)");
  },
});

Deno.test({
  name: "27.54 -- everything written under the data directory goes through one writer",
  permissions: { read: ["."], run: ["git"] },
  async fn() {
    /*
     * `writeUnderData` makes the parent directory and sets the mode to 0600, because the data
     * directory holds the payment block, PDFs with those details printed on them, and recordings
     * of somebody's voice — and both SQLite and `Deno.writeFile` create files at 0666 less the
     * umask, which is 0644 on an ordinary machine.
     *
     * The invoice PDF bypassed it, calling `Deno.writeFile` directly, so the one file with bank
     * details *printed* on it was the one written world-readable. I found that by writing this
     * guard, not by reading the code, and the audio path two hundred lines away had been correct
     * the whole time — which is what a second writer looks like.
     */
    const root = new URL("..", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of (await trackedFiles()).filter((f) => f.startsWith("server/"))) {
      if (file.endsWith("_test.ts")) continue;
      const text = await Deno.readTextFile(`${root}${file}`);
      for (const [i, line] of text.split("\n").entries()) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        // A write aimed at the data directory, by any of the ways one is spelled here.
        if (/Deno\.write(File|TextFile)\(/.test(line) && /dataDir|args\.data|\bat\b/.test(line)) {
          if (!text.slice(0, text.indexOf(line)).includes("function writeUnderData")) continue;
          if (/function writeUnderData/.test(text.split("\n")[i - 3] ?? "")) continue;
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      }
    }
    assertEquals(offenders, [], "a write under the data directory skips writeUnderData (27.54)");
  },
});

Deno.test({
  name: "an exported function is called by something",
  permissions: { read: ["."], run: ["git"] },
  async fn() {
    /*
     * Not a tidiness rule. The two this found were both worth knowing about:
     *
     * - `clearAddress`, written for 22.6 and called by nobody, which meant "Disconnect from this
     *   server" left the address in device storage and one reload undid it (27.57). An exported
     *   function with no callers is a question about the caller that should exist.
     * - `invoiceConfigGaps`, a fourth list of what an invoice is missing, disagreeing with the
     *   authority it duplicated — it omitted the BSB, the bank and the payment method. Dead, and
     *   a hazard while it existed, because the next person to need that list would have found it.
     *
     * A reference from a *test* counts. Something exported only so it can be tested is a decision,
     * and this is not the place to argue with it.
     */
    const root = new URL("..", import.meta.url).pathname;
    const files = (await trackedFiles()).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const text = new Map<string, string>();
    for (const f of files) text.set(f, await Deno.readTextFile(`${root}${f}`));

    const orphans: string[] = [];
    for (const [file, body] of text) {
      if (file.includes("_test")) continue;
      for (const found of body.matchAll(/^export (?:async )?function (\w+)/gm)) {
        const name = found[1]!;
        const used = new RegExp(`(?<![\\w.])${name}(?![\\w])`);
        const elsewhere = [...text].some(([g, t]) => g !== file && used.test(t));
        // Its own file counts too, minus the declaration itself: a helper used only where it lives
        // is over-exported, which is untidy rather than wrong.
        const here = (body.match(new RegExp(`(?<![\\w.])${name}(?![\\w])`, "g")) ?? []).length - 1;
        if (!elsewhere && here === 0) orphans.push(`${file}: ${name}`);
      }
    }
    assertEquals(orphans, [], "an exported function is called by nothing at all (27.58)");
  },
});
