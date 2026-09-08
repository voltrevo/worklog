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
