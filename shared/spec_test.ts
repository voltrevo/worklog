/**
 * `REQUIREMENTS.md` is append-only, and its item numbers are permanent identities.
 *
 * That is a decision, not a style: every comment in this codebase cites items by number, so `6.10`
 * has to mean the same thing forever. Superseded items are struck through in place and a new one
 * is added at the end of its section; sections themselves are only appended to.
 *
 * The convention is worth a test because it fails in a way review does not catch. Renumbering to
 * "tidy up" after striking something looks like an improvement and silently repoints several
 * hundred citations at the wrong sentences — and nothing would go red, because a comment citing
 * the wrong requirement still compiles.
 *
 * So: numbers within a section run 1..n with no gaps and no repeats, struck items keep their
 * places, and the sections themselves are in order. A gap means an item was deleted rather than
 * struck; a repeat means one was reused.
 */

import { assertEquals } from "jsr:@std/assert@^1";

const SPEC = new URL("../REQUIREMENTS.md", import.meta.url).pathname;

interface Item {
  section: number;
  index: number;
  struck: boolean;
}

async function items(): Promise<Item[]> {
  const text = await Deno.readTextFile(SPEC);
  const out: Item[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\.(\d+)\.\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      section: Number(m[1]),
      index: Number(m[2]),
      struck: m[3]!.trimStart().startsWith("~~"),
    });
  }
  return out;
}

const READS_SPEC: Pick<Deno.TestDefinition, "permissions"> = {
  permissions: { read: [SPEC] },
};

Deno.test({
  name: "every section numbers 1..n with no gaps, so nothing was deleted",
  ...READS_SPEC,
  async fn() {
    const bySection = new Map<number, number[]>();
    for (const item of await items()) {
      bySection.set(item.section, [...(bySection.get(item.section) ?? []), item.index]);
    }
    assertEquals(bySection.size > 0, true, "no requirements were parsed at all");

    const problems: string[] = [];
    for (const [section, indexes] of [...bySection].sort((a, b) => a[0] - b[0])) {
      const expected = Array.from({ length: Math.max(...indexes) }, (_, i) => i + 1);
      // Order matters too: an item inserted in the middle is an item that took a number.
      if (indexes.join(",") !== expected.join(",")) {
        problems.push(`section ${section}: ${indexes.join(",")} is not 1..${expected.length}`);
      }
    }
    assertEquals(problems, [], "append-only means struck in place, never renumbered");
  },
});

Deno.test({
  name: "sections themselves are in order and contiguous",
  ...READS_SPEC,
  async fn() {
    const sections = [...new Set((await items()).map((i) => i.section))];
    assertEquals(
      sections,
      [...sections].sort((a, b) => a - b),
      "a section appeared out of order, so one was inserted rather than appended",
    );
    assertEquals(
      sections,
      Array.from({ length: sections.length }, (_, i) => i + 1),
      "a section number is missing or repeated",
    );
  },
});

Deno.test({
  name: "struck items are still there, holding their numbers",
  ...READS_SPEC,
  async fn() {
    const all = await items();
    const struck = all.filter((i) => i.struck);
    // Not a fixed count — the point is that striking is how removal happens here, so if this ever
    // reaches zero while the sections keep growing, something is being deleted instead.
    assertEquals(struck.length > 0, true, "no struck items: has something been deleted outright?");
    assertEquals(
      struck.every((s) => all.some((i) => i.section === s.section && i.index === s.index)),
      true,
    );
  },
});

/**
 * A requirement states a need, and the document's own **What belongs here** says what that rules
 * out. Two parts of it are mechanically checkable, and this is a ratchet over both.
 *
 * **A ratchet rather than a limit, because the document does not pass yet.** It opened at 387 items
 * with a median of 67 characters, none longer than 172, and not one naming a source file. Eight days
 * later it held 598, of which 52 ran past 250 characters — almost all of them requirements with the
 * story of a bug still attached. Withdrawing the misfiled ones brought that to 27 and reducing the
 * rest to their first sentence brought it to 14; the remainder are items whose rule genuinely needs
 * the words. No item names a source file any more, so that ceiling is nought and can only stay
 * there. A ceiling that can only fall stops the number climbing back.
 *
 * 250 rather than 172, which was the original document's true maximum: the point is to catch a
 * paragraph, not to relitigate items that are merely long. Lower it as the count comes down.
 *
 * Neither number is the real rule — a 240-character item prescribing a layout is just as misfiled.
 * These are the parts a test can see.
 */
const LONG_ITEMS_CEILING = 14;
const FILE_NAMING_CEILING = 0;

function specItems(): { id: string; body: string }[] {
  const text = Deno.readTextFileSync(SPEC);
  const out: { id: string; body: string }[] = [];
  for (const m of text.matchAll(/^(\d+)\.(\d+)\.\s+(.*?)(?=\n\d+\.\d+\.|\n## |(?![\s\S]))/gms)) {
    const [, section, item, body] = m;
    if (!section || !item || body === undefined) continue;
    const text = body.replace(/\s+/g, " ").trim();
    // A struck item is history, not a requirement: it is exempt from both rules below. Striking
    // also *adds* characters — the `~~` and the reason — so counting them would make a cleanup
    // look like a regression, which is how this was found.
    if (text.startsWith("~~")) continue;
    out.push({ id: `${section}.${item}`, body: text });
  }
  return out;
}

Deno.test({
  name: "no more long items than there were, so the paragraphs can only go down",
  fn() {
    const long = specItems().filter((i) => i.body.length > 250);
    assertEquals(
      long.length <= LONG_ITEMS_CEILING,
      true,
      `${long.length} items run past 250 characters, up from ${LONG_ITEMS_CEILING}: ` +
        `${
          long.slice(-5).map((i) => i.id).join(", ")
        }. An item that long is usually a requirement ` +
        `with its bug story still attached — keep the first sentence and put the rest in the ` +
        `commit message and the comment beside the code. See "What belongs here".`,
    );
    // And when the cleanup lands, the ceiling comes down with it rather than staying slack.
    assertEquals(
      long.length >= LONG_ITEMS_CEILING - 5,
      true,
      `${long.length} long items against a ceiling of ${LONG_ITEMS_CEILING} — lower the ceiling to ` +
        `${long.length} so the ground that was won cannot be given back.`,
    );
  },
});

Deno.test({
  name: "and no more items naming a source file, which a requirement never needs to",
  fn() {
    const naming = specItems().filter((i) => /`[^`]*\.tsx?`/.test(i.body));
    assertEquals(
      naming.length <= FILE_NAMING_CEILING,
      true,
      `${naming.length} items name a source file: ${naming.map((i) => i.id).join(", ")}. ` +
        `A requirement outlives the file that satisfies it; name the need instead.`,
    );
  },
});
